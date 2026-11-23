import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"

import App from "./App"
import { AuthGate } from "./components/AuthGate"
import { installOAuthRelay } from "./utils/oauth-relay"
import { installCheckinNoticeRewrite } from "./utils/checkin-notice"
import "./App.less"

;(window as any).__ModuleLoader__ = {
  load: (row: any) => {
    ;(window as any).__JET_HUB_ROW__ = row
  },
}

// 尽早安装 OAuth 中继：改写 window.open 与页面上的 loopback 链接，远程部署时回调不再打不开。
installOAuthRelay()
// 一键签到提示：有账号渠道在前、省略无账号、末尾引导到全量明细（上游产物会被升级覆盖，故在本仓库改写）。
installCheckinNoticeRewrite()

const el = document.getElementById("c2a-root")
if (!el) {
  console.error("[admin] 找不到 #c2a-root")
} else {
  // 先渲染登录门，再加载上游界面：上游 bundle 失败不影响登录。
  createRoot(el).render(
    <BrowserRouter basename="/admin">
      <AuthGate>
        <App />
      </AuthGate>
    </BrowserRouter>,
  )
}
