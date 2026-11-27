/**
 * 会话层用例用的假连接：契约的每一条 procedure 都按 `reply` 回，事件由用例直接推入。
 *
 * 旧版里面真的建了一个 `SessionMirror`（客户端库那一个），因为「一片增量怎么折进消息」的规则在
 * 库里。新契约没有增量事件：流式期间每片都推一条整条消息的 `message.changed`，攒这件事
 * 于是只剩「按 id 整条替换」。折叠规则就在 `src/server-client/mirror.ts` —— 这里直接用真的
 * 那一个（不是替身），于是用例里推一条事件得到的镜像，与真连接上得到的那一份同源同规则。
 *
 * 事件的次序也照真连接：先折进镜像，再交给订阅者（`connection.ts` 的 `dispatch` 就是这么
 * 排的）。
 *
 * 只有「宿主怎么回」是假的：`reply(method, params)` 按 procedure 名（`session.rename` /
 * `agent.send` / `config.get` …）回答，路径由一条 `Proxy` 拼出来（`api.session.rename.mutate` →
 * `"session.rename"`）。`call` 那一侧用的是真实现（`createLegacyCall`）：只有
 * `session.create` / `session.send` 通，其余抛 `unsupported` —— 于是「未搬的域会抛」这件事在
 * 用例里也是真的。
 */

import { ClientError } from "../server-client/index.js";
import { SessionMirror } from "../server-client/mirror.js";
import { createLegacyCall } from "../server-client/methods.js";
import type { HostConnection, HostEvent, MirrorSessionRow } from "../session/types.js";

/** `session.open` 的假出参（用例用 `open` 那一格给） */
export interface FakeOpen {
  session: MirrorSessionRow;
  live: {
    state: "working" | "idle";
    inputPaused: boolean;
    outputPaused: boolean;
    handingOff: boolean;
  } | null;
  messages: unknown[];
  inbox: unknown[];
}

/** 一条假连接：在 {@link HostConnection} 之上多几个只给用例用的口子 */
export interface FakeConnection extends HostConnection {
  /** 让宿主「推一条」（先折进镜像，再交给订阅者 —— 与真连接同一序） */
  emit(event: HostEvent): void;
  /** 事件流报错（断线） */
  emitError(error: unknown): void;
  /** 每一次 procedure 调用（按先后；方法名就是 procedure 名） */
  calls: Array<{ method: string; params: unknown }>;
  /** 只看方法名的调用轨迹（断言「打了哪几条」用） */
  methods(): string[];
  /** `open` / `resync` 各被调了几次 */
  opens: string[];
  resyncs: string[];
  /** 打开着的镜像（用例直接往里看事实） */
  mirrors: Map<string, SessionMirror>;
  /** 连接被关了吗 */
  closed: boolean;
}

/** {@link fakeConnection} 的入参 */
export interface FakeConnectionOptions {
  /** 一条 procedure 怎么回；抛错（或回一个 `Error`）等于宿主回了错 */
  reply?: (method: string, params: unknown) => unknown;
  /** `session.open` / `resync` 回什么；回一个 `Error` 就等于宿主拒了那一次（例如会话没了） */
  open?: (sessionId: string) => FakeOpen | Error;
  /** 旧路的语言（`unsupported` 那句话的语种） */
  language?: string;
}

/**
 * 一条假连接。
 */
export function fakeConnection(options: FakeConnectionOptions = {}): FakeConnection {
  const reply = options.reply ?? (() => undefined);
  const language = options.language ?? "zh";
  const calls: Array<{ method: string; params: unknown }> = [];
  const opens: string[] = [];
  const resyncs: string[] = [];
  const mirrors = new Map<string, SessionMirror>();
  const handlers = new Set<{
    onEvent: (event: HostEvent) => void;
    onError?: (error: unknown) => void;
  }>();

  /** 这一条事件属于哪一段会话 */
  const sessionOf = (event: HostEvent): string | null => {
    if (event.type === "session.changed") return event.session.id;
    if (event.type === "notice") return event.notice.sessionId;
    if (event.type === "notice.cleared") return event.sessionId ?? null;
    return event.sessionId;
  };

  const deliver = (event: HostEvent): void => {
    const sessionId = sessionOf(event);
    if (sessionId !== null) mirrors.get(sessionId)?.apply(event);
    for (const handler of [...handlers]) handler.onEvent(event);
  };

  const load = async (sessionId: string): Promise<SessionMirror> => {
    const view = options.open?.(sessionId);
    if (view === undefined) throw new Error(`用例没给 session.open(${sessionId}) 打桩`);
    if (view instanceof Error) throw view;
    const mirror = mirrors.get(sessionId) ?? new SessionMirror(view.session);
    mirrors.set(sessionId, mirror);
    mirror.applyOpen(view);
    return mirror;
  };

  /**
   * 假 `api`：叶子是 `{ query, mutate }` 两个函数，路径按 `Proxy` 拼成 procedure 名。
   *
   * 名字用点拼而不是驼峰：`session.rename` 这种点号全名就是 tRPC 的 procedure 名，照抄最不容易错。
   * tRPC 的 procedure 名本来就是 `session.updateThinkingLevel` 这种点号全名，照抄最不容易错。
   */
  const makeApi = (path: string[]): unknown =>
    new Proxy(Object.create(null) as object, {
      get(_target, property: string) {
        if (property === "query" || property === "mutate") {
          const method = path.join(".");
          return async (params?: unknown) => {
            calls.push({ method, params });
            const value = reply(method, params);
            if (value instanceof Error) throw value;
            return value;
          };
        }
        return makeApi([...path, property]);
      },
    });

  const api = makeApi([]) as HostConnection["api"];

  const connection: FakeConnection = {
    calls,
    mirrors,
    opens,
    resyncs,
    closed: false,
    language,
    api,
    // 旧路的实现是真的那一份（见文件头）
    call: createLegacyCall(api, language),
    methods: () => calls.map((entry) => entry.method),
    subscribe(onEvent, onError) {
      const handler = { onEvent, ...(onError === undefined ? {} : { onError }) };
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    open: async (sessionId: string) => {
      opens.push(sessionId);
      return await load(sessionId);
    },
    resync: async (sessionId: string) => {
      resyncs.push(sessionId);
      return await load(sessionId);
    },
    closeMirror(sessionId: string) {
      mirrors.delete(sessionId);
    },
    reconnect: async () => {},
    close: async () => {
      connection.closed = true;
    },
    emit(event) {
      deliver(event);
    },
    emitError(error) {
      for (const handler of [...handlers]) handler.onError?.(error);
    },
  };

  return connection;
}

/** 造一条「宿主这一版没接这条」的错（`call` 的未搬域回的就是它） */
export function unsupportedError(method: string): ClientError {
  return new ClientError("unsupported", `这一版还没接 \`${method}\` 这条旧路`, {
    detail: { method },
  });
}
