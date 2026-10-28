// 给模块化工具包的 modules.json 签名，写出 modules.json.sig（base64 的 ed25519 签名，和组件索引同一把钥匙）。
// App 更新工具包时（Updater.planModules）用内置公钥验它。也拿来签整包清单 devkit.lock.json（Updater.lockSigned 验）。
//   CI：   INDEX_SIGNING_KEY=<PEM>          node scripts/sign-modules.mjs out/modules/modules.json
//   本机： INDEX_SIGNING_KEY_FILE=<pem 路径> node scripts/sign-modules.mjs modules.json
// 补签已发布的 Release：gh release download <tag> -p modules.json，签好后 gh release upload <tag> modules.json.sig --clobber
import fs from "node:fs";
import crypto from "node:crypto";
const file = process.argv[2];
if (!file) { console.error("用法: node sign-modules.mjs <modules.json>"); process.exit(2); }
const pem = process.env.INDEX_SIGNING_KEY || (process.env.INDEX_SIGNING_KEY_FILE && fs.readFileSync(process.env.INDEX_SIGNING_KEY_FILE, "utf8"));
if (!pem) { console.error("✗ 没给签名私钥（INDEX_SIGNING_KEY 或 INDEX_SIGNING_KEY_FILE）"); process.exit(1); }
const body = fs.readFileSync(file);
const sig = crypto.sign(null, body, crypto.createPrivateKey(pem));
// 签完用 App 内置的同一把公钥自检一遍，钥匙拿错了当场发现
const PUB = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from("4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=", "base64")]), format: "der", type: "spki" });
if (!crypto.verify(null, body, PUB, sig)) { console.error("✗ 签出来的和 App 内置公钥对不上：钥匙拿错了"); process.exit(1); }
fs.writeFileSync(file + ".sig", sig.toString("base64") + "\n");
console.log(`✓ ${file}.sig`);
