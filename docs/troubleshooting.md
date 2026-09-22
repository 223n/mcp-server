# トラブルシューティング

## コネクタが「認証が必要」と言い続ける

Cloudflare Accessを外したつもりでも、claude.aiのコネクタが認証を求め続けることがあります。
2026年9月22日に実際に起きた例をもとに、調べ方と直し方をまとめます。

### 誰が401を返しているかを確かめる

まず、公開しているURLに認証なしで送ります。

```powershell
curl.exe -i -X POST https://mcp.223n.tech/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl\",\"version\":\"0\"}}}'
```

応答の形で、401を返しているものが分かります。

| 応答                                                                                         | 返しているもの                                            |
|----------------------------------------------------------------------------------------------|-----------------------------------------------------------|
| 401で、`WWW-Authenticate`の`resource_metadata`が`cloudflare-access-protected-resource`を指す | Cloudflare Access（Managed OAuthが有効）                  |
| ブラウザで開くと`<チーム名>.cloudflareaccess.com`のログインの画面へ302で飛ぶ                 | Cloudflare Access                                         |
| 401で、本文が`{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},...}`        | このサーバーの認証（`MCP_AUTH_TOKEN`か`CF_ACCESS_*`）     |
| 403で、本文がJSON-RPCのエラー                                                                | このサーバーの`Host`か`Origin`の確かめ（`ALLOWED_HOSTS`） |

リクエストがサーバーまで届いたかは、`docker logs ollama-mcp`のアクセスログで分かります。
cloudflaredのメトリクス（`http://127.0.0.1:20241/metrics`の`cloudflared_tunnel_total_requests`）が増えていなければ、トンネルの手前で止まっています。

### 実際に起きたこと

原因は2つありました。

- `mcp.223n.tech`の全体にかかるAccessのアプリが残り、Managed OAuthも有効のままでした
- Accessのアプリは、ポリシーに当てはまらない人をすべて拒みます。ポリシーやログインの方法を外しても、アプリがある限り保護は外れません

Accessのアプリを探すときは、ログインの画面へのURLの`kid`を見ます。
`kid`はアプリのAUDで、「Access controls」の「Applications」でアプリを開くと同じ値が出ます。

### 直し方

- Accessを外すなら、ポリシーではなくアプリを消すか、アプリの対象から外したいホスト名を外します
- Accessを使い続けるなら、同じホスト名のアプリを1つにまとめ、[README.md](../README.md)の「リモートで使う」のとおりに設定します
- Accessのアプリを作り直したら、`.env`の`CF_ACCESS_AUD`を新しいアプリのAUDに書き換えて、コンテナーを作り直します

### Claudeの側で要ること

カスタムコネクタの認証の方式は、足したときに決まり、あとから変えられません。
Accessの設定を変えたら、コネクタを消して足し直します。
