#!/usr/bin/env node
/**
 * 麦当劳 MCP 命令行调用器（麦麦小助手 skill 内置脚本）
 *
 * 用法：
 *   node mcp.js <工具名> '<JSON参数>' [--token <TOKEN>] [--raw]
 *
 * 示例：
 *   node mcp.js query-nearby-stores '{"beType":1,"searchType":2,"city":"北京市","keyword":"国贸"}'
 *   node mcp.js available-coupons '{}'
 *   node mcp.js query-meals '{"storeCode":"1950564","orderType":1,"beType":1}'
 *
 * Token 获取顺序：--token 参数 > 环境变量 MCD_MCP_TOKEN > 点餐应用 .env 文件。
 * 输出：成功时打印业务信封 JSON（{success,code,message,data}）；失败时打印错误信息并以非零码退出。
 * 零依赖，Node >= 18（原生 fetch）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MCP_URL = 'https://mcp.mcd.cn/';

/** 在常见位置查找点餐应用的 .env 并读取 MCD_MCP_TOKEN */
function findTokenFromAppEnv() {
  const candidates = [
    path.join(process.env.USERPROFILE || 'C:\\Users\\86181', '下载', '*', 'mcd-order-app', '.env'),
    'D:\\下载\\2026-10-21-09-25-55\\mcd-order-app\\.env',
    path.join(process.env.USERPROFILE || '', 'mcd-order-app', '.env'),
  ];
  for (const p of candidates) {
    if (p.includes('*')) {
      // 通配：扫描 下载 目录下的一级子目录
      const base = path.dirname(path.dirname(p));
      try {
        for (const d of fs.readdirSync(base)) {
          const env = path.join(base, d, 'mcd-order-app', '.env');
          if (fs.existsSync(env)) return readEnvToken(env);
        }
      } catch (_) { /* ignore */ }
      continue;
    }
    if (fs.existsSync(p)) return readEnvToken(p);
  }
  return null;
}

function readEnvToken(envPath) {
  try {
    const m = fs.readFileSync(envPath, 'utf8').match(/^\s*MCD_MCP_TOKEN\s*=\s*(\S+)/m);
    if (m && m[1] && !m[1].startsWith('在此粘贴')) return m[1];
  } catch (_) { /* ignore */ }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const tool = argv[0];
  if (!tool || tool.startsWith('-')) {
    console.error('用法: node mcp.js <工具名> \'<JSON参数>\' [--token <TOKEN>] [--raw]');
    console.error('示例: node mcp.js available-coupons \'{}\'');
    process.exit(2);
  }
  let argsRaw = argv[1] && !argv[1].startsWith('-') ? argv[1] : '{}';
  let token = null;
  let raw = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--token') token = argv[++i];
    else if (argv[i] === '--raw') raw = true;
  }
  token = token || process.env.MCD_MCP_TOKEN || findTokenFromAppEnv();
  if (!token) {
    console.error('未找到 MCP Token：请用 --token 传入，或设置环境变量 MCD_MCP_TOKEN，或在点餐应用 .env 中配置。');
    process.exit(3);
  }

  let args;
  try { args = JSON.parse(argsRaw); } catch (e) {
    console.error('参数不是合法 JSON：' + e.message);
    process.exit(2);
  }

  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    });
    if (!res.ok) {
      console.error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      process.exit(4);
    }
    const json = await res.json();
    if (json.error) {
      console.error('RPC 错误: ' + (json.error.message || JSON.stringify(json.error)));
      process.exit(4);
    }
    const result = json.result || {};
    if (result.isError) {
      const text = (result.content || []).map((c) => c.text || '').join(' ');
      console.error('工具错误: ' + text.slice(0, 500));
      process.exit(5);
    }
    const data = result.structuredContent
      || (() => { try { return JSON.parse((result.content || []).map((c) => c.text || '').join(' ')); } catch (_) { return { text: (result.content || []).map((c) => c.text || '').join(' ') }; } })();
    // 业务信封 success:false 时以非零码退出，但完整输出信封便于排查
    if (data && typeof data === 'object' && data.success === false) {
      console.error(`业务拒绝: code=${data.code} message=${data.message}`);
      console.log(JSON.stringify(data, null, 2));
      process.exit(6);
    }
    console.log(raw ? JSON.stringify(data) : JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('请求失败: ' + e.message);
    process.exit(4);
  }
}

main();
