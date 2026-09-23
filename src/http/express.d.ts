// 認証のミドルウェアが載せる識別子を、Express の Request に足す。
// 監査のために index.ts が読み、ツールの呼び出しに持ち回る。
// 型だけの宣言なので、実行時には何も起きない。
import "express";

declare module "express-serve-static-core" {
  interface Request {
    /** 認証を通した相手。"token"、Access の email、または `sub:...` */
    mcpIdentity?: string;
  }
}
