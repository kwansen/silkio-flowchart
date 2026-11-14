# flowchart

基于 [silkor](../) 画布内核的 流程图 场景包，包名 `silkio-flowchart`。

## 安装

```sh
pnpm add silkio-flowchart
```

`@silkor/core` 与 `@silkor/preset` 会作为依赖一并安装。

## 使用

便捷模式：场景内部通过 `@silkor/preset` 的 `officialPlugins()` 自动完成插件装配，开箱即用；也支持宿主自建 `App` 的显式装配。

对外导出见 `src/index.ts`。`examples/demo-flowchart` 是可运行的 Astro + Vue 演示。

## 开发

```sh
pnpm install
pnpm check:deps   # 边界守护：禁止直连插件、禁止依赖另一个场景仓
pnpm build
pnpm test
```

`pnpm check:deps` 会把「场景包只依赖 core + preset」这条规则机械化。官方插件清单以 `@silkor/preset` 的 `officialPlugins()` 为单一事实来源，本仓不得直接依赖 `@silkor/plugin-*`。

> 依赖的 `@silkor/core` / `@silkor/preset` 固定从 npm 安装正式版本，不再链接本地源码。需要改内核时在 `silkor` 仓开发并发布，再升级本仓的依赖版本号。

## 版本约定

依赖的 `@silkor/core` / `@silkor/preset` 版本号必须与 `silkor` 仓当前发布的版本族一致。能力键常量在 core、实现在插件，版本错配会到 `app.require(...)` 运行时才暴露。

## License

ISC
