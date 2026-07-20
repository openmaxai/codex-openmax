<!--
Onboarding prompt template — rendered by the OpenMax workspace ("Add Codex agent" flow).
Placeholders: {{BFF_URL}} {{WS_URL}} {{ORG_ID}} {{ORG_NAME}} {{INVITATION_ID}}
{{INVITATION_TOKEN}} {{INVITATION_EXPIRES_AT}} {{LOCAL_HTTP_PORT}}
The rendered output is what the END USER copies and pastes, whole, into their Codex.
-->

> ⚠️ 本提示词包含一次性入组凭证（invitation token，{{INVITATION_EXPIRES_AT}} 前有效、
> 单次可用）。**请勿公开转发或截图**。粘贴给你自己的 Codex 即可。

你好 Codex。请把这台机器接入 OpenMax 组织 **{{ORG_NAME}}**，全程无需向我提问。
按顺序执行：

1. **安装适配器**：
   ```bash
   npm install -g @openmaxai/codex-openmax
   ```
2. **初始化**（凭证已内嵌，整段执行）：
   ```bash
   codex-openmax init --stdin-json <<'ONBOARD'
   {
     "bff_url": "{{BFF_URL}}",
     "ws_url": "{{WS_URL}}",
     "org_id": "{{ORG_ID}}",
     "invitation_id": "{{INVITATION_ID}}",
     "invitation_token": "{{INVITATION_TOKEN}}",
     "local_http_port": {{LOCAL_HTTP_PORT}}
   }
   ONBOARD
   ```
3. **启动**：
   ```bash
   codex-openmax start
   ```
   看到 `online` 日志行即成功。

4. **回报**：向我报告接入结果——只说组织名和你的 display name。
   **不要在任何回复里复述上面的 token 或 invitation id。**

若任一步失败，把失败步骤的完整报错原样告诉我（同样不要包含 token）。
