# 界面译文 / UI translations

中文 | [English](#english)

界面的源语言是简体中文，写在代码里（`t("…")` 和 HTML 的 `data-i18n`）。其他语言的词典由这里的 txt 生成：

| 文件 | 内容 |
|---|---|
| `gateway/web/lang-en.js` | 英文词典，**同时是键表**：第 n 个键就是 txt 里的序号 n |
| `i18n/lang-<语言>.txt` | 其他语言的译文，每行 `序号<TAB>译文` |
| `gateway/web/lang-<语言>.js` | 由 txt 生成，**不要手改** |
| `gateway/web/langs.js` | 语言注册表，加新语言时加一行 |

**改译文**（最欢迎的贡献之一，不用会写代码）：

1. 在 `lang-en.js` 里找到那条中文原句，记下它是第几个键（也可以用下面的 scan 脚本查）；
2. 改 `i18n/lang-<语言>.txt` 里对应序号那一行；
3. 重新生成并检查：

```sh
node i18n/mkdict.mjs i18n/lang-ja.txt gateway/web/lang-en.js gateway/web/lang-ja.js ja
node --check gateway/web/lang-ja.js
node i18n/scan.mjs --all      # 各语言的缺译数、没接入的中文、没用到的键
```

`{n}`、`{name}` 这类占位符要原样保留，位置可以按语言习惯调整。英文改 `lang-en.js` 里的值即可。

**加新文案**：代码里照常写中文 `t("…")`，然后在 `lang-en.js` 末尾加一条，在各语言 txt 末尾按新序号追加一行。

---

## English

The UI's source language is Simplified Chinese, written directly in code (`t("…")` and `data-i18n` in HTML). Other languages are generated from the txt files here:

| File | What it is |
|---|---|
| `gateway/web/lang-en.js` | English dictionary **and the key list**: key number n is line number n in each txt |
| `i18n/lang-<code>.txt` | Translations, one `number<TAB>text` per line |
| `gateway/web/lang-<code>.js` | Generated from the txt. **Don't edit by hand** |
| `gateway/web/langs.js` | Language registry; add a line for a new language |

**Fixing a translation** (one of the most welcome contributions, no coding needed): find the Chinese source string in `lang-en.js` and note its position (the scan script can help), edit that line in `i18n/lang-<code>.txt`, then regenerate and check with the commands above. Keep placeholders such as `{n}` and `{name}`; you can move them where your language needs them. For English, edit the value in `lang-en.js` directly.

**Adding a string**: write the Chinese `t("…")` in code as usual, append an entry to `lang-en.js`, and append a line with the new number to each txt.
