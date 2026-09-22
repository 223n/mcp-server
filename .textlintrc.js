// 日本語の検査規則。公開されている共有設定 @223n/lint-config-ja の「ですます調」版を使う。
//
// 文体を「である調」にしたい場合は、次のように書き換える。
//   module.exports = require('@223n/lint-config-ja')
//
// 一部だけ変えたい場合は、設定を作る関数を直に呼ぶ。
//   const { createTextlintConfig } = require('@223n/lint-config-ja/config/textlint-base.js')
//   module.exports = createTextlintConfig({ style: 'ですます', sentenceLength: 100 })
//
// 規則の理由は https://github.com/223n/node_japanese_lint_template を見よ。
module.exports = require('@223n/lint-config-ja/config/textlint-desumasu.js')
