// 「经加载器」执行方式下 node 是经 /system/bin/linker64 起的，process.execPath 于是成了 linker64，
// 网关拿它拉子 node（priv.mjs、pkg、设备工具 MCP…）会变成「linker64 脚本.mjs」直接失败。
// termux-exec 改写 exec 时把原程序路径放在 TERMUX_EXEC__PROC_SELF_EXE（网关本身由 GatewayService 设），改回去即可。
// 由 NODE_OPTIONS=--require 挂到每个 node 进程上
const self = process.env.TERMUX_EXEC__PROC_SELF_EXE;
if (self && /\/linker64$/.test(process.execPath)) process.execPath = self;
