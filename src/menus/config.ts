/**
 * 配置管理菜单
 *
 * 所有配置读写委托给 SDK 的 readConfig / saveConfig。
 * 菜单 UI 通过 config 对象的类型化字段直接操作，无需中间包装函数。
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { readConfig, saveConfig, readMcpConfig, writeMcpConfig } from "../config.js";
import type { Endpoint, Model, ImageModel } from "@ai-zen/agents-sdk";
import type { McpServersMap } from "../config.js";
import { showConfig } from "./config-display.js";
import { maskApiKey, selectFromList, SEPARATOR } from "./common.js";

// ==================== 端点相关 ====================

function showEndpoints(): void {
  const config = readConfig();
  console.log(chalk.blue.bold("\n🌐 端点列表:\n"));
  for (const ep of config.endpoints) {
    console.log(chalk.white(`  ${ep.name} (${ep.id})`));
    console.log(chalk.gray(`     API Key: ${maskApiKey(ep.apiKey)}`));
    console.log(chalk.gray(`     Base URL: ${ep.baseUrl}`));
    console.log(SEPARATOR);
  }
}

async function editEndpoint(): Promise<void> {
  const config = readConfig();
  const endpointId = await selectFromList(config.endpoints, {
    message: "选择要编辑的端点:",
    getName: (e: Endpoint) => `${e.name} (${e.id}) ${e.apiKey ? "✅" : "❌"}`,
    getValue: (e: Endpoint) => e.id,
    emptyMessage: "⚠️  没有端点",
    backLabel: "🔙 取消",
  });
  if (!endpointId) return;

  const endpoint = config.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) return;

  const { field } = await inquirer.prompt([
    {
      type: "list",
      name: "field",
      message: "选择要修改的字段:",
      choices: [
        { name: `名称 (当前: ${endpoint.name})`, value: "name" },
        { name: `Base URL (当前: ${endpoint.baseUrl})`, value: "baseUrl" },
        { name: `API Key (当前: ${endpoint.apiKey ? "已设置" : "未设置"})`, value: "apiKey" },
        { name: `描述 (当前: ${endpoint.description || "无"})`, value: "description" },
        { name: "🔙 取消", value: "back" },
      ],
    },
  ]);
  if (field === "back") return;

  const { value } = await inquirer.prompt([
    {
      type: field === "apiKey" ? "password" : "input",
      name: "value",
      message: `请输入新的${field === "name" ? "名称" : field === "baseUrl" ? "Base URL" : field === "apiKey" ? "API Key" : "描述"}:`,
      default: String((endpoint as unknown as Record<string, unknown>)[field] ?? ""),
      mask: field === "apiKey" ? "*" : undefined,
    },
  ]);

  (endpoint as unknown as Record<string, unknown>)[field] = value;
  saveConfig(config);
  console.log(chalk.green(`\n✅ 端点已更新\n`));
}

async function setApiKeyInteractive(): Promise<void> {
  const config = readConfig();
  const endpointId = await selectFromList(config.endpoints, {
    message: "选择要设置 API Key 的端点:",
    getName: (e: Endpoint) => `${e.name} (${e.id}) ${e.apiKey ? "✅" : "❌"}`,
    getValue: (e: Endpoint) => e.id,
    emptyMessage: "⚠️  没有端点",
    backLabel: "🔙 取消",
  });
  if (!endpointId) return;

  const endpoint = config.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) return;

  const { apiKey } = await inquirer.prompt([
    {
      type: "password",
      name: "apiKey",
      message: `输入 ${endpoint.name} 的 API Key:`,
      mask: "*",
      validate: (input: string) => input.trim() !== "" || "API Key 不能为空",
    },
  ]);

  endpoint.apiKey = apiKey;
  saveConfig(config);
  console.log(chalk.green(`\n✅ ${endpoint.name} API Key 已设置\n`));
}

// ==================== 模型相关 ====================

async function setDefaultModelInteractive(): Promise<void> {
  const config = readConfig();
  const modelId = await selectFromList(config.models, {
    message: "选择默认对话模型:",
    getName: (m: Model) => `${m.name} (${m.id})${config.defaultModel === m.id ? " ⭐ 当前" : ""}`,
    getValue: (m: Model) => m.id,
    emptyMessage: "⚠️  没有可用的对话模型",
    backLabel: "🔙 取消",
  });
  if (!modelId) return;
  config.defaultModel = modelId;
  saveConfig(config);
  const model = config.models.find((m) => m.id === modelId);
  console.log(chalk.green(`\n✅ 默认对话模型已设置为 "${model?.name}"\n`));
}

async function setDefaultImageModelInteractive(): Promise<void> {
  const config = readConfig();
  const imageModels = config.imageModels || [];
  const modelId = await selectFromList(imageModels, {
    message: "选择默认图片生成模型:",
    getName: (m: ImageModel) => `${m.name} (${m.id})${config.defaultImageModel === m.id ? " ⭐ 当前" : ""}`,
    getValue: (m: ImageModel) => m.id,
    emptyMessage: "⚠️  没有可用的图片生成模型",
    backLabel: "🔙 取消",
  });
  if (!modelId) return;
  config.defaultImageModel = modelId;
  saveConfig(config);
  const model = imageModels.find((m) => m.id === modelId);
  console.log(chalk.green(`\n✅ 默认图片生成模型已设置为 "${model?.name}"\n`));
}

function showModels(): void {
  const config = readConfig();
  console.log(chalk.blue.bold("\n🔧 对话模型列表:\n"));
  if (config.models.length === 0) {
    console.log(chalk.yellow("  (无)\n"));
    return;
  }
  for (const model of config.models) {
    const ep = config.endpoints.find((e) => e.id === model.endpointId);
    const isDefault = config.defaultModel === model.id;
    console.log(chalk.white(`  ${isDefault ? "⭐ " : "  "}${model.name} (${model.id})`));
    console.log(chalk.gray(`     端点: ${ep ? ep.name : "未知"}`));
    console.log(chalk.gray(`     模型名: ${model.modelName || model.id}`));
    if (model.description) console.log(chalk.gray(`     描述: ${model.description}`));
    console.log(SEPARATOR);
  }
}

function showImageModels(): void {
  const config = readConfig();
  const imageModels = config.imageModels || [];
  console.log(chalk.blue.bold("\n🎨 图片生成模型列表:\n"));
  if (imageModels.length === 0) {
    console.log(chalk.yellow("  (无)\n"));
    return;
  }
  for (const model of imageModels) {
    const ep = config.endpoints.find((e) => e.id === model.endpointId);
    const isDefault = config.defaultImageModel === model.id;
    console.log(chalk.white(`  ${isDefault ? "⭐ " : "  "}${model.name} (${model.id})`));
    console.log(chalk.gray(`     端点: ${ep ? ep.name : "未知"}`));
    console.log(chalk.gray(`     模型名: ${model.modelName || model.id}`));
    if (model.defaultSize) console.log(chalk.gray(`     默认尺寸: ${model.defaultSize}`));
    if (model.defaultQuality) console.log(chalk.gray(`     默认质量: ${model.defaultQuality}`));
    console.log(SEPARATOR);
  }
}

// ==================== MCP 服务器管理（操作 mcp.json）====================

function showMcpServers(): void {
  const mcp = readMcpConfig();
  const names = Object.keys(mcp.servers);
  console.log(chalk.blue.bold("\n🔌 MCP 服务器列表:\n"));
  if (names.length === 0) {
    console.log(chalk.yellow("  (未配置 MCP 服务器)\n"));
    return;
  }
  for (const name of names) {
    const srv = mcp.servers[name];
    console.log(chalk.white(`  ${name}`));
    console.log(chalk.gray(`     传输方式: ${srv.transport}`));
    if (srv.transport === "stdio") {
      console.log(chalk.gray(`     命令: ${srv.command}`));
      if (srv.args?.length) console.log(chalk.gray(`     参数: ${srv.args.join(" ")}`));
    } else {
      console.log(chalk.gray(`     URL: ${srv.url}`));
    }
    console.log(SEPARATOR);
  }
}

async function addMcpServer(): Promise<void> {
  const { name, transport } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "服务器名称（唯一标识）:",
      validate: (input: string) => input.trim() !== "" || "名称不能为空",
    },
    {
      type: "list",
      name: "transport",
      message: "传输方式:",
      choices: [
        { name: "stdio（本地子进程）", value: "stdio" },
        { name: "HTTP/SSE（远程）", value: "http" },
      ],
    },
  ]);

  const server: Record<string, unknown> = { transport };

  if (transport === "stdio") {
    const { command, args } = await inquirer.prompt([
      {
        type: "input",
        name: "command",
        message: "启动命令:",
        validate: (input: string) => input.trim() !== "" || "命令不能为空",
      },
      {
        type: "input",
        name: "args",
        message: "命令参数（空格分隔，可选）:",
      },
    ]);
    server.command = command;
    server.args = args.trim() ? args.trim().split(/\s+/) : undefined;
  } else {
    const { url } = await inquirer.prompt([
      {
        type: "input",
        name: "url",
        message: "URL:",
        validate: (input: string) => input.trim() !== "" || "URL 不能为空",
      },
    ]);
    server.url = url;
  }

  const mcp = readMcpConfig();
  if (mcp.servers[name]) {
    console.log(chalk.red(`\n❌ 服务器 "${name}" 已存在\n`));
    return;
  }
  mcp.servers[name] = server as McpServersMap[string];
  writeMcpConfig(mcp);
  console.log(chalk.green(`\n✅ MCP 服务器 "${name}" 已添加\n`));
}

async function editMcpServer(): Promise<void> {
  const mcp = readMcpConfig();
  const names = Object.keys(mcp.servers);

  const serverName = await selectFromList(names.map((n) => ({ name: n })), {
    message: "选择要编辑的 MCP 服务器:",
    getName: (item: { name: string }) => item.name,
    getValue: (item: { name: string }) => item.name,
    emptyMessage: "⚠️  没有 MCP 服务器",
    backLabel: "🔙 取消",
  });
  if (!serverName) return;

  const server = mcp.servers[serverName];
  if (!server) return;

  const { field } = await inquirer.prompt([
    {
      type: "list",
      name: "field",
      message: "选择操作:",
      choices: [
        { name: `名称 (当前: ${serverName})`, value: "name" },
        ...(server.transport === "stdio"
          ? [
              { name: `命令 (当前: ${server.command})`, value: "command" },
              { name: `参数 (当前: ${(server.args || []).join(" ") || "无"})`, value: "args" },
            ]
          : [{ name: `URL (当前: ${server.url})`, value: "url" }]),
        { name: "🗑️  删除此服务器", value: "delete" },
        { name: "🔙 取消", value: "back" },
      ],
    },
  ]);

  if (field === "back") return;

  if (field === "delete") {
    delete mcp.servers[serverName];
    writeMcpConfig(mcp);
    console.log(chalk.green(`\n✅ MCP 服务器 "${serverName}" 已删除\n`));
    return;
  }

  if (field === "name") {
    const { newName } = await inquirer.prompt([
      {
        type: "input",
        name: "newName",
        message: "新名称:",
        default: serverName,
        validate: (input: string) => input.trim() !== "" || "名称不能为空",
      },
    ]);
    if (newName !== serverName) {
      mcp.servers[newName] = server;
      delete mcp.servers[serverName];
    }
    writeMcpConfig(mcp);
    console.log(chalk.green(`\n✅ MCP 服务器已重命名\n`));
    return;
  }

  const { value } = await inquirer.prompt([
    {
      type: "input",
      name: "value",
      message: `请输入新${field === "command" ? "命令" : field === "args" ? "参数（空格分隔）" : "URL"}:`,
      default: field === "args" ? (server.args || []).join(" ") : String((server as Record<string, unknown>)[field] ?? ""),
    },
  ]);

  if (field === "args") {
    server.args = value.trim() ? value.trim().split(/\s+/) : [];
  } else {
    (server as Record<string, unknown>)[field] = value;
  }
  writeMcpConfig(mcp);
  console.log(chalk.green(`\n✅ MCP 服务器已更新\n`));
}

// ==================== 配置管理主菜单 ====================

export async function showInteractiveConfig(): Promise<void> {
  while (true) {
    console.log(chalk.blue.bold("\n⚙️  配置管理\n"));

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "请选择操作:",
        choices: [
          { name: "📋 查看当前配置（总览）", value: "show" },
          { name: "⭐ 设置默认对话模型", value: "set-default-model" },
          { name: "⭐ 设置默认图片生成模型", value: "set-default-image-model" },
          { name: "🔑 设置 API Key", value: "set-key" },
          { name: "🔧 编辑 API", value: "edit-endpoint" },
          { name: "🌐 查看所有 API", value: "list-endpoints" },
          { name: "📋 查看对话模型", value: "list-models" },
          { name: "📋 查看图片生成模型", value: "list-image-models" },
          { name: "🔌 管理 MCP 服务器", value: "mcp" },
          { name: "🔙 返回主菜单", value: "back" },
        ],
      },
    ]);

    switch (action) {
      case "show": showConfig(); break;
      case "set-key": await setApiKeyInteractive(); break;
      case "list-endpoints": showEndpoints(); break;
      case "edit-endpoint": await editEndpoint(); break;
      case "list-models": showModels(); break;
      case "set-default-model": await setDefaultModelInteractive(); break;
      case "list-image-models": showImageModels(); break;
      case "set-default-image-model": await setDefaultImageModelInteractive(); break;
      case "mcp": await manageMcpServers(); break;
      case "back": return;
    }
  }
}

async function manageMcpServers(): Promise<void> {
  while (true) {
    console.log(chalk.blue.bold("\n🔌 MCP 服务器管理\n"));

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "请选择操作:",
        choices: [
          { name: "📋 查看所有 MCP 服务器", value: "list" },
          { name: "➕ 新增 MCP 服务器", value: "add" },
          { name: "✏️  编辑/删除 MCP 服务器", value: "edit" },
          { name: "🔙 返回配置管理", value: "back" },
        ],
      },
    ]);

    switch (action) {
      case "list": showMcpServers(); break;
      case "add": await addMcpServer(); break;
      case "edit": await editMcpServer(); break;
      case "back": return;
    }
  }
}
