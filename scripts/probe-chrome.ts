import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: [
    'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    '--ws-endpoint=ws://127.0.0.1:9222/devtools/browser',
    '--no-usage-statistics',
    '--no-performance-crux',
  ],
  stderr: 'pipe',
});
const client = new Client({ name: 'xiaoe-download-probe', version: '0.1.0' });
try {
  await client.connect(transport);
  const pages = await client.callTool({ name: 'list_pages', arguments: {} });
  const content = pages.content;
  if (!Array.isArray(content)) throw new Error('页面列表返回格式不正确');
  const text = content.map((block) => ('text' in block ? String(block.text) : '')).join('\n');
  const match = text
    .split('\n')
    .find((line) => line.includes('/ecommerce/pay_record/record'))
    ?.match(/^(\d+):/);
  if (!match) throw new Error('未发现购买记录页面');
  console.log(`已连接现有 Chrome MCP，购买记录页面 ID: ${match[1]}`);
} finally {
  await client.close();
}
