/**
 * CharacterLife · console 公共入口（`characterlife/console`）。
 *
 * 主人后台服务与引擎插件协议；扩展通过 `InstanceExtension.consolePlugin()` 贡献面板。
 */

export { createConsoleServer, semanticsView } from './server.ts'
export type { ConsoleServerOptions, ConsoleServerHandle } from './server.ts'
export type {
    ConsoleValue,
    ConsoleField,
    ConsoleAction,
    ConsoleSection,
    ConsolePanel,
    ConsolePlugin,
} from './plugin.ts'
