#!/usr/bin/env node
// CLI entry: parse --port/--host, export them, then boot the server.
const argv = process.argv.slice(2);

// 共享的 --port/-p、--host/-H、--version/-v、--help/-h 解析。
// - helpText 在 --help 时打印；prog 用于未知选项报错前缀（如 'agentlray thin'）。
// - 返回 { port, host }（初值取自同名环境变量；显式 flag 覆盖）。
// - --version / --help / 未知选项 内部处理并 process.exit，不会返回。
function parseServeArgs(args, { prog, helpText }) {
  let port = process.env.PORT;
  let host = process.env.HOST;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const next = () => (inline !== null ? inline : args[++i]);
    if (flag === '--port' || flag === '-p') port = next();
    else if (flag === '--host' || flag === '-H') host = next();
    else if (flag === '--version' || flag === '-v') {
      console.log(require('../package.json').version);
      process.exit(0);
    } else if (flag === '--help' || flag === '-h') {
      console.log(helpText);
      process.exit(0);
    } else {
      console.error(`${prog}: unknown option '${arg}'`);
      process.exit(1);
    }
  }
  return { port, host };
}

if (['inspect', 'evidence'].includes(argv[0])) {
  void require('./inspect').main(argv.slice(1), argv[0]);
} else if (argv[0] === 'sessions') {
  void require('./sessions').main(argv.slice(1), argv[0]);
} else if (argv[0] === 'platform') {
  void require('./platform').main(argv.slice(1), argv[0]);
} else if (argv[0] === 'thin') {
  // 薄服务：仅远程连接的轻量网关（design-thin-service）。默认 PORT=3801 / HOST=127.0.0.1，
  // 可用 --port/--host 覆盖。配置仍用 ~/.agentlray/hosts.json（可用 AGENTLRAY_HOME 隔离）。
  const { port, host } = parseServeArgs(argv.slice(1), {
    prog: 'agentlray thin',
    helpText:
      'Usage: agentlray thin [--port <port>] [--host <host>] [--version]\n' +
      '薄服务：仅远程连接（默认 PORT=3801, HOST=127.0.0.1）。\n' +
      '自动连接 AGENTLRAY_THIN_HOST 指定的主机，缺省连接 hosts.json 第一台。',
  });
  if (port) process.env.PORT = String(port);
  if (host) process.env.HOST = String(host);
  require('../bin/thin-server.js');
} else {
  const { port, host } = parseServeArgs(argv, {
    prog: 'agentlray',
    helpText:
      'Usage: agentlray [--port <port>] [--host <host>] [--version]\n' +
      'Offline evidence: agentlray inspect --help\n' +
      'Explicit raw evidence: agentlray evidence --help\n' +
      'Session queries/resume: agentlray sessions --help\n' +
      'Platform queries: agentlray platform --help\n' +
      'Thin service (remote-only): agentlray thin --help',
  });
  if (port) process.env.PORT = String(port);
  if (host) process.env.HOST = String(host);

  require('../server.js');
}
