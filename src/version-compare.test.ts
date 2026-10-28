import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, pickNewest } from "./version-compare.js";

describe("parseVersion", () => {
  it("拆出核心段与预发布标识", () => {
    expect(parseVersion("1.2.3")).toEqual({ core: [1, 2, 3], pre: [] });
    expect(parseVersion("1.0.0-alpha.23")).toEqual({ core: [1, 0, 0], pre: ["alpha", "23"] });
  });

  it("忽略构建元数据与 v 前缀", () => {
    expect(parseVersion("v1.2.3+build.7")).toEqual({ core: [1, 2, 3], pre: [] });
    expect(parseVersion("1.2.3-alpha+exp.sha.5114f85")).toEqual({ core: [1, 2, 3], pre: ["alpha"] });
  });

  it("畸形输入返回 null（不抛错）", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("abc")).toBeNull();
    expect(parseVersion("1.x.3")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("核心段按数值比，不是字典序", () => {
    expect(compareVersions("0.9.0", "1.0.0-alpha.23")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("预发布版小于同号正式版", () => {
    expect(compareVersions("1.0.0-alpha.23", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-alpha.23")).toBeGreaterThan(0);
  });

  it("预发布标识：数字比数值、数字小于非数字、标识少的更小", () => {
    expect(compareVersions("1.0.0-alpha.9", "1.0.0-alpha.23")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });

  it("相同（含构建元数据差异）返回 0", () => {
    expect(compareVersions("1.0.0-alpha.23", "1.0.0-alpha.23")).toBe(0);
    expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
  });

  it("任一方畸形返回 null", () => {
    expect(compareVersions("1.0.0", "nope")).toBeNull();
  });
});

describe("pickNewest", () => {
  it("在多个 dist-tag 之间取 semver 最大的那个", () => {
    // 真实发布状态：正式版 latest 落后于 alpha，按 semver 该选 alpha
    expect(pickNewest(["0.9.0", "1.0.0-alpha.23"])).toBe("1.0.0-alpha.23");
    // 正式版追上之后反过来选正式版
    expect(pickNewest(["0.9.0", "1.0.0-alpha.23", "1.0.0"])).toBe("1.0.0");
  });

  it("跳过畸形条目；全非法返回 undefined", () => {
    expect(pickNewest(["nope", "0.1.0"])).toBe("0.1.0");
    expect(pickNewest([])).toBeUndefined();
    expect(pickNewest(["nope", ""])).toBeUndefined();
  });
});
