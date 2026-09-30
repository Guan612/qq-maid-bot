import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { getDefaultStore, Provider as JotaiProvider } from "jotai";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen.js";
import { bootstrapAuth } from "./stores/auth.js";
import { themeController, themePresetAtom } from "./stores/theme.js";
import "./styles/global.css";

// 主题 controller 单例在 stores/theme.ts 创建：立即应用主题防闪烁，
// 并把预设镜像进 jotai 供组件只读订阅。
getDefaultStore().set(themePresetAtom, themeController.current().preset);

// server state 统一交给 TanStack Query；全局 30s 轮询由各页面的 useQuery 选项声明。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

// hash 路由：Rust 侧只托管固定入口 HTML，hash 模式无需服务端 fallback。
const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* stores/* 层的所有命令式写入都走 getDefaultStore()；裸 Provider 会另建私有 store，
        导致认证状态等更新对组件树不可见（页面卡在"正在恢复管理员会话"），必须显式共用默认 store。 */}
    <JotaiProvider store={getDefaultStore()}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </JotaiProvider>
  </StrictMode>,
);

// 启动会话恢复不阻塞首帧：认证门先显示检查态，结果通过 jotai 通知。
void bootstrapAuth();
