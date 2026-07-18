import chalk from "chalk";
import { readConfig, CONFIG_FILE, readMcpConfig, MCP_CONFIG_FILE } from "../config.js";
import type { Model, ImageModel } from "@ai-zen/agents-sdk";
import { maskApiKey, SEPARATOR } from "./common.js";

export function showConfig(): void {
  const config = readConfig();
  console.log(chalk.blue.bold("\n📋 当前配置总览\n"));

  console.log(chalk.blue.bold("🌐 端点:"));
  if (config.endpoints.length === 0) {
    console.log(chalk.yellow("  (无)"));
  } else {
    for (const ep of config.endpoints) {
      console.log(chalk.white(`  ${ep.name} (${ep.id})`));
      console.log(chalk.gray(`    API Key: ${maskApiKey(ep.apiKey)}`));
      console.log(chalk.gray(`    Base URL: ${ep.baseUrl}`));
    }
  }
  console.log(SEPARATOR);

  console.log(chalk.blue.bold("⭐ 默认模型:"));
  if (config.defaultModel) {
    const model = config.models.find((m: Model) => m.id === config.defaultModel);
    console.log(chalk.white(`  ${model?.name || config.defaultModel}`));
  } else {
    console.log(chalk.yellow("  (未设置)"));
  }
  console.log(SEPARATOR);

  console.log(chalk.blue.bold("🎨 默认图片模型:"));
  if (config.defaultImageModel) {
    const model = (config.imageModels || []).find((m: ImageModel) => m.id === config.defaultImageModel);
    console.log(chalk.white(`  ${model?.name || config.defaultImageModel}`));
  } else {
    console.log(chalk.yellow("  (未设置)"));
  }
  console.log(SEPARATOR);

  console.log(chalk.blue.bold("🤖 默认 Agent:"));
  if (config.defaultAgent) {
    console.log(chalk.white(`  ${config.defaultAgent}`));
  } else {
    console.log(chalk.yellow("  (未设置)"));
  }
  console.log(SEPARATOR);

  console.log(chalk.blue.bold("🔌 MCP 服务器:"));
  const mcp = readMcpConfig();
  const names = Object.keys(mcp.servers);
  if (names.length === 0) {
    console.log(chalk.yellow("  (未配置)"));
  } else {
    for (const name of names) {
      const srv = mcp.servers[name];
      console.log(chalk.white(`  ${name}`));
      console.log(chalk.gray(`     传输方式: ${srv.transport}`));
      if (srv.transport === "stdio") {
        console.log(chalk.gray(`     命令: ${srv.command}`));
      } else {
        console.log(chalk.gray(`     URL: ${srv.url}`));
      }
    }
  }
  console.log(SEPARATOR);
  console.log(chalk.gray(`配置文件路径: ${CONFIG_FILE}`));
  console.log(chalk.gray(`MCP 配置路径: ${MCP_CONFIG_FILE}`));
  console.log();
}
