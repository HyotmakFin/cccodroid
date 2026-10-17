package cc.codroid;

import android.system.Os;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.BufferedReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.zip.GZIPInputStream;
import org.json.JSONObject;

/** 首次安装：把 devkit tar 解到 files/ 下、跑 first-run、再装官方 Claude Code。全程只写本应用私有目录。 */
final class Installer {
    interface Progress { void step(String msg); void bytes(long done, long total); }

    private final Env env;
    private final Progress ui;

    Installer(Env env, Progress ui) { this.env = env; this.ui = ui; }
    void step(String m) { ui.step(m); }

    // ── devkit 下载 ────────────────────────────────────────────────────
    /**
     * 从 Release 取工具包：先读同一 Release 里的 devkit.lock.json（gz 的文件名、大小、sha256），
     * 再把 .tar.gz 下到私有目录 —— 断点续传（Range）、失败重试、多个地址依次换，sha256 对上才交给 installDevkit。
     * 先落盘再解压：边下边解的话网络一断就得从头来，600MB 在手机网络上经不起。
     * @param bases Release 下载目录（…/releases/download/<tag>/），按顺序尝试
     * @return 校验过的本地 .tar.gz
     */
    File downloadDevkit(String[] bases) throws IOException {
        IOException last = null;
        for (String base : bases) {
            try {
                ui.step("获取工具包清单：" + base);
                JSONObject lock = new JSONObject(new String(httpGetSmall(base + "devkit.lock.json"), StandardCharsets.UTF_8));
                JSONObject gz = lock.getJSONObject("gz");
                String name = gz.getString("file"), sha = gz.getString("sha256");
                long size = gz.getLong("bytes");
                File done = new File(env.files, name), part = new File(env.files, name + ".part"), tag = new File(env.files, name + ".sha256");
                lastBase = base; lastSha = sha;
                JSONObject tarInfo = lock.optJSONObject("tar");
                lastTarSha = tarInfo != null ? tarInfo.optString("sha256", null) : null;
                // 空间先算清再下：下到一半才报「No space left」，用户白等十分钟还看不懂。
                // 峰值 = 还没下完的压缩包 + 解开后的全部文件（压缩包解完才删）+ Claude Code 与余量
                long have = done.isFile() ? done.length() : part.length();
                long tarBytes = tarInfo != null ? tarInfo.optLong("bytes", 0) : 0;
                long need = Math.max(0, size - have) + (tarBytes > 0 ? tarBytes : size * 3) + (400L << 20);
                long free = new android.os.StatFs(env.files.getPath()).getAvailableBytes();
                if (free < need) throw new NoSpace(need, free);
                if (done.isFile() && done.length() == size && sha.equals(sha256(done))) return done;
                // .part 属于别的版本就作废，别把两个版本拼在一起
                if (!tag.isFile() || !sha.equals(new String(java.nio.file.Files.readAllBytes(tag.toPath()), StandardCharsets.UTF_8).trim())) {
                    part.delete();
                    write(tag, sha + "\n");
                }
                ui.step(String.format("下载开发工具包 %.0f MB%s…", size / 1048576.0, part.length() > 0 ? String.format("（续传，已有 %.0f MB）", part.length() / 1048576.0) : ""));
                for (int attempt = 1; part.length() < size; attempt++) {
                    try { fetchRange(base + name, part, size); }
                    catch (IOException e) {
                        if (attempt >= 8) throw e;
                        ui.step("  网络中断（" + e.getMessage() + "），" + (attempt * 3) + " 秒后续传…");
                        try { Thread.sleep(attempt * 3000L); } catch (InterruptedException ie) { throw new IOException(ie); }
                    }
                }
                ui.step("校验 sha256…");
                String got = sha256(part);
                if (!sha.equals(got)) { part.delete(); throw new IOException("sha256 不符（期望 " + sha.substring(0, 12) + "…，实得 " + got.substring(0, 12) + "…）"); }
                if (!part.renameTo(done)) throw new IOException("换名失败: " + part);
                tag.delete();
                return done;
            } catch (Exception e) {
                if (e instanceof NoSpace) throw (NoSpace) e;      // 换个下载地址也没用
                last = e instanceof IOException ? (IOException) e : new IOException(e.getMessage(), e);
                ui.step("  ✗ " + e.getMessage());
            }
        }
        throw last != null ? last : new IOException("没有可用的下载地址");
    }

    /** 存储空间不够：消息直接给用户看，写清要多少、还剩多少 */
    static final class NoSpace extends IOException {
        NoSpace(long need, long free) {
            super(String.format(java.util.Locale.ROOT, "存储空间不够：安装需要约 %.1f GB，手机里目前只剩 %.1f GB。清理出空间后点「重试」即可（已下载的部分会保留）。",
                need / 1073741824.0, free / 1073741824.0));
        }
    }

    /** 最近一次 downloadDevkit 用的 Release 目录、gz 与 tar 的 sha256（installDevkit 记进 .devkit-ok，更新检查据此比对） */
    String lastBase, lastSha, lastTarSha;

    /**
     * 通用下载：断点续传 + 重试 + sha256（sha 为 null 则不校验）。.part 旁边的 .sha256 记着它属于哪个版本，
     * 换了版本就作废重下，别把两个版本拼在一起。
     */
    File download(String url, File done, long size, String sha) throws IOException { return download(url, null, done, size, sha); }

    /** alt：备用地址（同一个文件的镜像）。主地址连着失败两次就换过去，接着同一个 .part 续传；内容由 sha256 把关，镜像不需要被信任 */
    File download(String url, String alt, File done, long size, String sha) throws IOException {
        if (done.isFile() && (size <= 0 || done.length() == size) && (sha == null || sha.equals(sha256(done)))) return done;
        File part = new File(done.getPath() + ".part"), tag = new File(done.getPath() + ".sha256");
        done.getParentFile().mkdirs();
        String id = sha != null ? sha : url;
        if (!tag.isFile() || !id.equals(new String(java.nio.file.Files.readAllBytes(tag.toPath()), StandardCharsets.UTF_8).trim())) {
            part.delete();
            write(tag, id + "\n");
        }
        for (int attempt = 1; size <= 0 || part.length() < size; attempt++) {
            try { fetchRange(url, part, size); if (size <= 0) break; }
            catch (IOException e) {
                if (alt != null && !url.equals(alt) && attempt >= 2) {
                    url = alt;
                    ui.step("  GitHub 下载不顺（" + e.getMessage() + "），改从 cccodroid.net 镜像续传…");
                    continue;
                }
                if (attempt >= 8) throw e;
                ui.step("  网络中断（" + e.getMessage() + "），" + (attempt * 3) + " 秒后续传…");
                try { Thread.sleep(attempt * 3000L); } catch (InterruptedException ie) { throw new IOException(ie); }
            }
        }
        if (sha != null) {
            String got = sha256(part);
            if (!sha.equals(got)) { part.delete(); throw new IOException("sha256 不符（期望 " + sha.substring(0, 12) + "…，实得 " + got.substring(0, 12) + "…）"); }
        }
        done.delete();
        if (!part.renameTo(done)) throw new IOException("换名失败: " + part);
        tag.delete();
        return done;
    }

    static byte[] httpGetSmall(String url) throws IOException {
        HttpURLConnection c = open(url);
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode() + " " + url);
            try (InputStream in = c.getInputStream()) { return readAllBytes(in); }
        } finally { c.disconnect(); }
    }

    /** 从 part 现有长度续传到结束；服务器不认 Range（回 200）就从头写 */
    private void fetchRange(String url, File part, long size) throws IOException {
        long have = part.length();
        HttpURLConnection c = open(url);
        if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
        try {
            int code = c.getResponseCode();
            boolean append = code == 206;
            if (code != 200 && code != 206) throw new IOException("HTTP " + code);
            if (!append) have = 0;
            try (InputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16);
                 OutputStream out = new FileOutputStream(part, append)) {
                byte[] buf = new byte[1 << 16];
                long tick = 0;
                for (int r; (r = in.read(buf)) > 0; ) {
                    out.write(buf, 0, r);
                    have += r;
                    if (have - tick > (2 << 20)) { tick = have; ui.bytes(have, size); }
                }
            }
            ui.bytes(have, size);
        } finally { c.disconnect(); }
    }

    static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);      // GitHub Release 会 302 到 objects.githubusercontent.com
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);                 // 60 秒没来一个字节就当断了，交给续传
        return c;
    }

    static String sha256(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 20];
            for (int r; (r = in.read(buf)) > 0; ) md.update(buf, 0, r);
            return hex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
    }

    private static byte[] readAllBytes(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int r; (r = in.read(buf)) > 0; ) b.write(buf, 0, r);
        return b.toByteArray();
    }

    // ── devkit ─────────────────────────────────────────────────────────
    //
    // 替换分四步，每一步被打断（进程被杀、APK 升级重启、没电）都能在下次启动时由 recover() 收拾干净：
    //   1. 解到 usr.new/，边解边算 tar 的 sha256，和清单对不上就整个丢掉 —— 旧工具包一根毫毛不动
    //   2. 校验通过后在 usr.new/ 里写 .devkit-pending（要装成哪一版）
    //   3. usr → usr.old，usr.new → usr（两次换名）
    //   4. finish()：搬用户自装的东西、first-run、写 .devkit-ok、删 usr.old
    // .devkit-ok 是最后写的：没有它，网关不会启动，更新检查也不会把这份工具包当成装好了。
    static final String PENDING = ".devkit-pending";
    File usrNew() { return new File(env.files, "usr.new"); }
    File usrOld() { return new File(env.files, "usr.old"); }

    void installDevkit(String source) throws IOException { installDevkit(source, lastBase, lastSha, lastTarSha); }

    /** @param base/sha/tarSha 这份工具包来自哪个 Release、gz 与 tar 的 sha256（本地文件安装时可为 null）—— 写进 .devkit-ok，更新检查拿它比 */
    void installDevkit(String source, String base, String sha, String tarSha) throws IOException {
        // 本地文件没给 sha：自己算一个。已装记录里有了内容身份，更新检查才不会把它误认成别的版本
        if (sha == null && !source.startsWith("http")) { ui.step("计算工具包校验和…"); sha = sha256(new File(source)); }
        ui.step("解包开发工具包…");
        InputStream raw; long total;
        if (source.startsWith("http")) {
            HttpURLConnection c = (HttpURLConnection) new URL(source).openConnection();
            c.setInstanceFollowRedirects(true);
            raw = c.getInputStream(); total = c.getContentLengthLong();
        } else {
            File f = new File(source);
            raw = new FileInputStream(f); total = f.length();
        }
        Counting in = new Counting(new BufferedInputStream(raw, 1 << 20), total);
        MessageDigest md;
        try { md = MessageDigest.getInstance("SHA-256"); } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
        java.security.DigestInputStream s = new java.security.DigestInputStream(source.endsWith(".gz") ? new GZIPInputStream(in, 1 << 16) : in, md);
        File tmp = usrNew();
        deleteTree(tmp);
        tmp.mkdirs();
        try {
            untar(s, tmp, "usr/");
            byte[] sink = new byte[1 << 16];
            while (s.read(sink) > 0) { }            // tar 末尾的填充块也算进校验和
        } catch (IOException e) {
            deleteTree(tmp);
            throw new IOException("解包失败，旧工具包未改动：" + e.getMessage(), e);
        } finally { s.close(); }
        String got = hex(md.digest());
        if (tarSha != null && !tarSha.isEmpty() && !tarSha.equals(got)) {
            deleteTree(tmp);
            throw new IOException("解出来的内容与清单不符（tar sha256 期望 " + tarSha.substring(0, 12) + "…，实得 " + got.substring(0, 12) + "…），旧工具包未改动");
        }
        JSONObject p = new JSONObject();
        try { p.put("base", base == null ? "" : base).put("sha256", sha == null ? "" : sha).put("tarSha256", got); }
        catch (org.json.JSONException ignored) {}
        write(new File(tmp, PENDING), p + "\n");
        swapIn(tmp);
        finish();
    }

    /** 两次换名把新版换上；第二次失败就把旧版换回来 */
    private void swapIn(File tmp) throws IOException {
        File old = usrOld();
        deleteTree(old);
        if (env.usr.exists() && !env.usr.renameTo(old)) throw new IOException("换名失败: " + env.usr);
        if (!tmp.renameTo(env.usr)) {
            if (old.exists()) old.renameTo(env.usr);
            throw new IOException("换名失败: " + tmp);
        }
    }

    /** 换名之后的几步。可重入：中途被打断，下次启动 recover() 会再跑一遍 */
    private void finish() throws IOException {
        File old = usrOld(), pend = new File(env.usr, PENDING);
        JSONObject p;
        try { p = new JSONObject(new String(java.nio.file.Files.readAllBytes(pend.toPath()), StandardCharsets.UTF_8)); }
        catch (Exception e) { p = new JSONObject(); }
        if (old.isDirectory()) carryOver(old, env.usr);
        new File(env.usr, "tmp").mkdirs();
        env.home.mkdirs();

        long since = System.currentTimeMillis() - 2000;      // 文件系统时间戳精度留点余量
        ui.step("首次运行配置…");
        int rc = run(env.bin("bash").getPath(), new File(env.usr, "libexec/devkit/first-run.sh").getPath());
        if (rc != 0) ui.step("（first-run 返回 " + rc + "，不影响使用）");
        // Guile 的编译缓存必须比源码新（哪怕包里两者同一秒），否则 gdb 启动时陷入重编译死循环
        run(env.bin("bash").getPath(), "-c", "find \"$PREFIX/lib/guile\" -name '*.go' -exec touch {} + 2>/dev/null; true");
        writeResolvConf();
        pruneManifest(since);
        try { p.put("at", System.currentTimeMillis()); } catch (org.json.JSONException ignored) {}
        write(new File(env.usr, ".devkit-ok"), p + "\n");       // 从这一刻起才算装好
        pend.delete();
        if (old.exists()) { ui.step("清理旧版本…"); deleteTree(old); }
    }

    /**
     * 启动时先调：上次装工具包被打断的话，把目录收拾到一致状态。
     * @return 动过东西（接着装完了，或者退回了旧版）
     */
    /** 有没有上次中断留下要收拾的东西。只看不动 —— 没有就别去停网关 */
    boolean needsRecovery() {
        File neu = usrNew(), old = usrOld();
        return neu.exists() || old.exists() || new File(env.usr, PENDING).isFile();
    }

    /** recover() 这次做了什么（给修复账本用）；什么都没做时为 null */
    String recovered;

    boolean recover() throws IOException {
        File neu = usrNew(), old = usrOld();
        boolean did = false;
        recovered = null;
        // 断在两次换名之间：旧版已换下、新版（校验过的）还没换上
        if (!env.usr.exists() && neu.isDirectory() && new File(neu, PENDING).isFile()) {
            if (!neu.renameTo(env.usr)) throw new IOException("换名失败: " + neu);
            did = true;
            recovered = "两次换名之间被打断：把已校验的新版换上";
        }
        if (new File(env.usr, PENDING).isFile()) {
            ui.step("上次的开发工具包更新被打断了，接着完成…");
            finish();
            recovered = (recovered == null ? "" : recovered + "；") + "上次更新在收尾阶段被打断：重跑首次配置并写好校验基线";
            return true;
        }
        if (!env.usr.exists() && old.isDirectory()) { old.renameTo(env.usr); did = true; recovered = "新版没换上：退回旧版"; }   // 新版没成：退回旧版
        if (neu.exists()) { deleteTree(neu); did = true; recovered = (recovered == null ? "" : recovered + "；") + "删掉解到一半的新版"; }   // 解到一半的残骸
        if (old.exists() && new File(env.usr, ".devkit-ok").isFile()) deleteTree(old);
        return did;
    }

    // ── 完整性：工具包里的 libexec/devkit/MANIFEST 记着每个文件的 sha256 与大小 ──
    static final String MANIFEST = "libexec/devkit/MANIFEST", LOCAL_MANIFEST = ".devkit-manifest";

    /**
     * 本机校验基线：包里的清单 + first-run 的改动。postinst 会删掉个别文件（剔除），也会现场重写一些
     * （例如 git-delta 重新生成补全脚本 —— 按改动时间认出来，按实际内容重记）。tar 里的文件保留了打包时的
     * 修改时间，first-run 写过的才是现在的时间，所以拿 since 一比就分得开。
     */
    private void pruneManifest(long since) {
        File man = new File(env.usr, MANIFEST);
        if (!man.isFile()) return;
        try {
            StringBuilder sb = new StringBuilder();
            int dropped = 0, rebased = 0;
            for (String l : java.nio.file.Files.readAllLines(man.toPath(), StandardCharsets.UTF_8)) {
                String[] f = l.split(" ", 3);
                if (f.length != 3) continue;
                File file = new File(env.usr, f[2]);
                if (!file.isFile()) { dropped++; continue; }
                if (file.lastModified() >= since) {
                    String h = sha256(file);
                    if (!h.equals(f[0])) { l = h + " " + file.length() + " " + f[2]; rebased++; }
                }
                sb.append(l).append('\n');
            }
            write(new File(env.usr, LOCAL_MANIFEST), sb.toString());
            if (dropped + rebased > 0) ui.step("（首次配置删掉 " + dropped + " 个、改写 " + rebased + " 个文件，校验基线已按实际情况记下）");
        } catch (IOException e) { ui.step("（校验基线没写成：" + e.getMessage() + "）"); }
    }

    /** 用户可能自己动的地方：配置、pip / npm 装的包。改了不算坏，只有"缺了"才算 */
    private static boolean userTouchable(String rel) {
        return rel.startsWith("etc/") || rel.startsWith("glibc/etc/") || rel.startsWith("var/")
            || rel.matches("lib/python3\\.\\d+/site-packages/.*") || rel.startsWith("lib/node_modules/");
    }

    /**
     * 核对已装工具包。full=false 只看文件在不在（几秒）；full=true 逐个算 sha256（一两分钟）。
     * @return {manifest, total, missing, changed, samples[]}；manifest=false 表示这一版工具包没带清单
     */
    JSONObject verifyDevkit(boolean full) throws Exception {
        JSONObject r = new JSONObject();
        File man = new File(env.usr, LOCAL_MANIFEST);
        if (!man.isFile()) man = new File(env.usr, MANIFEST);
        if (!man.isFile()) return r.put("manifest", false);
        java.util.List<String> lines = java.nio.file.Files.readAllLines(man.toPath(), StandardCharsets.UTF_8);
        int missing = 0, changed = 0, i = 0;
        long bytes = 0, doneBytes = 0;
        for (String l : lines) { String[] f = l.split(" ", 3); if (f.length == 3) bytes += Long.parseLong(f[1]); }
        org.json.JSONArray samples = new org.json.JSONArray();
        for (String l : lines) {
            String[] f = l.split(" ", 3);
            if (f.length != 3) continue;
            i++;
            String rel = f[2];
            long size = Long.parseLong(f[1]);
            File file = new File(env.usr, rel);
            boolean bad = false, gone = !file.isFile();
            if (userTouchable(rel)) gone = false;
            else if (gone) { missing++; bad = true; }
            else if (full && !userTouchable(rel) && (file.length() != size || !f[0].equals(sha256(file)))) { changed++; bad = true; }
            if (bad && samples.length() < 12) samples.put((gone ? "缺失 " : "改动 ") + rel);
            doneBytes += full ? size : 0;
            if ((i & 255) == 0) ui.bytes(full ? doneBytes : i, full ? bytes : lines.size());
        }
        return r.put("manifest", true).put("total", i).put("missing", missing).put("changed", changed).put("samples", samples);
    }

    static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /**
     * 更新工具包时，把用户自己装进 $PREFIX 的东西搬到新目录：pip（不带 --user）、npm -g 装的包和它们的命令。
     * 判断"用户自己装的"：不在旧工具包任何一个包的文件清单（var/lib/dpkg/info/*.list）里，且新工具包里没有同名的。
     * Python 小版本变了就不搬 site-packages（编译过的扩展对不上新解释器）。
     */
    private void carryOver(File old, File neu) {
        java.util.Set<String> owned = new java.util.HashSet<>();
        File[] lists = new File(old, "var/lib/dpkg/info").listFiles((d, n) -> n.endsWith(".list"));
        if (lists != null) for (File l : lists) {
            try { for (String line : java.nio.file.Files.readAllLines(l.toPath())) owned.add(line.trim()); }
            catch (IOException ignored) {}
        }
        String pre = env.usr.getPath() + "/";
        java.util.List<String> dirs = new java.util.ArrayList<>(java.util.Arrays.asList("bin", "lib/node_modules"));
        File[] py = new File(old, "lib").listFiles((d, n) -> n.matches("python3\\.\\d+"));
        if (py != null) for (File p : py) if (new File(neu, "lib/" + p.getName()).isDirectory()) dirs.add("lib/" + p.getName() + "/site-packages");
        int n = 0;
        for (String d : dirs) {
            File[] kids = new File(old, d).listFiles();
            if (kids == null) continue;
            for (File k : kids) {
                String rel = d + "/" + k.getName();
                if (owned.contains(pre + rel) || owned.contains("/" + rel)) continue;
                File to = new File(neu, rel);
                if (to.exists() || isSymlink(to)) continue;
                to.getParentFile().mkdirs();
                if (k.renameTo(to)) n++;
            }
        }
        if (n > 0) ui.step("保留了你自己装进工具包的 " + n + " 项（pip / npm -g 等）");
    }

    /** glibc 版程序（官方 Claude Code）解析域名靠它；安卓没有 /etc/resolv.conf */
    private void writeResolvConf() throws IOException {
        File etc = new File(env.usr, "glibc/etc");
        etc.mkdirs();
        write(new File(etc, "resolv.conf"), "nameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 223.5.5.5\n");
        File hosts = new File(etc, "hosts");
        if (!hosts.exists()) write(hosts, "127.0.0.1 localhost\n::1 localhost\n");
    }

    // ── 官方 Claude Code ───────────────────────────────────────────────
    void installClaude(File script) throws IOException {
        ui.step("从官方渠道下载 Claude Code…");
        int rc = run(env.bin("bash").getPath(), script.getPath());
        if (rc != 0 || !env.claudeReady()) throw new IOException("Claude Code 安装失败（rc=" + rc + "）");
    }

    int run(String... cmd) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        env.apply(pb.environment());
        pb.directory(env.home);
        pb.redirectErrorStream(true);
        Process p = pb.start();
        BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
        for (String l; (l = r.readLine()) != null; ) {
            // 脚本用 "@progress 已下 总量" 报进度：画进度条，不进日志
            if (l.startsWith("@progress ")) {
                String[] p2 = l.split(" ");
                try { ui.bytes(Long.parseLong(p2[1]), Long.parseLong(p2[2])); } catch (Exception ignored) {}
                continue;
            }
            ui.step(l);
        }
        try { return p.waitFor(); } catch (InterruptedException e) { throw new IOException(e); }
    }

    // ── tar（ustar + GNU 长名 + pax）────────────────────────────────────
    private void untar(InputStream in, File root, String strip) throws IOException {
        byte[] h = new byte[512];
        String longName = null, longLink = null;
        String rootPath = root.getCanonicalPath();
        while (true) {
            if (!readFully(in, h)) break;
            if (allZero(h)) break;
            long size = octal(h, 124, 12);
            char type = (char) (h[156] == 0 ? '0' : h[156]);
            int mode = (int) octal(h, 100, 8);
            long mtime = octal(h, 136, 12);
            if (type == 'L' || type == 'K' || type == 'x' || type == 'g') {
                byte[] body = readBody(in, size);
                if (type == 'L') longName = cstr(body, 0, body.length);
                else if (type == 'K') longLink = cstr(body, 0, body.length);
                else if (type == 'x') {
                    String pax = new String(body, StandardCharsets.UTF_8);
                    for (int i = 0; i < pax.length(); ) {
                        int sp = pax.indexOf(' ', i);
                        int len = Integer.parseInt(pax.substring(i, sp));
                        String kv = pax.substring(sp + 1, i + len - 1);
                        int eq = kv.indexOf('=');
                        if (kv.startsWith("path=")) longName = kv.substring(eq + 1);
                        if (kv.startsWith("linkpath=")) longLink = kv.substring(eq + 1);
                        i += len;
                    }
                }
                continue;
            }
            String prefix = cstr(h, 345, 155);
            String name = longName != null ? longName : (prefix.isEmpty() ? "" : prefix + "/") + cstr(h, 0, 100);
            String link = longLink != null ? longLink : cstr(h, 157, 100);
            longName = longLink = null;
            if (name.startsWith("./")) name = name.substring(2);
            if (!name.startsWith(strip)) { skip(in, size); continue; }
            name = name.substring(strip.length());
            if (name.isEmpty() || name.equals("/")) { skip(in, size); continue; }
            File f = new File(root, name);
            if (!f.getCanonicalPath().startsWith(rootPath) && type != '2') throw new IOException("越界条目: " + name);
            try {
                switch (type) {
                    case '5':
                        f.mkdirs();
                        Os.chmod(f.getPath(), (mode & 0777) | 0700);
                        break;
                    case '2':
                        f.getParentFile().mkdirs();
                        f.delete();
                        Os.symlink(link, f.getPath());
                        break;
                    case '1': {
                        String target = link.startsWith("./") ? link.substring(2) : link;
                        if (target.startsWith(strip)) target = target.substring(strip.length());
                        f.getParentFile().mkdirs();
                        f.delete();
                        Os.link(new File(root, target).getPath(), f.getPath());
                        break;
                    }
                    case '0': case '7': {
                        f.getParentFile().mkdirs();
                        try (OutputStream o = new FileOutputStream(f)) { copy(in, o, size); }
                        pad(in, size);
                        Os.chmod(f.getPath(), (mode & 0777) | 0600);
                        // 保留包里的修改时间。不保留的话一律是解包那一刻，先后全凭解包顺序 ——
                        // gdb 内嵌的 Guile 一看 .scm 比编译好的 .go 新，就逐个重编译（而编译器本身用不了），
                        // 表现为 gdb 任何参数都无输出、原地空转烧 CPU。make 之类按时间戳判断的工具也会被搅乱。
                        if (mtime > 0) f.setLastModified(mtime * 1000);
                        continue;
                    }
                    default:
                        break;
                }
            } catch (android.system.ErrnoException e) {
                throw new IOException(name + ": " + e.getMessage());
            }
            skip(in, size);
        }
    }

    private static boolean readFully(InputStream in, byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int n = in.read(b, off, b.length - off);
            if (n < 0) { if (off == 0) return false; throw new IOException("tar 截断"); }
            off += n;
        }
        return true;
    }
    private static byte[] readBody(InputStream in, long size) throws IOException {
        byte[] b = new byte[(int) size];
        readFully(in, b);
        pad(in, size);
        return b;
    }
    private static void copy(InputStream in, OutputStream o, long size) throws IOException {
        byte[] buf = new byte[1 << 16];
        while (size > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, size));
            if (n < 0) throw new IOException("tar 截断");
            o.write(buf, 0, n);
            size -= n;
        }
    }
    private static void skip(InputStream in, long size) throws IOException {
        long n = (size + 511) / 512 * 512;
        byte[] buf = new byte[8192];
        while (n > 0) { int r = in.read(buf, 0, (int) Math.min(buf.length, n)); if (r < 0) throw new IOException("tar 截断"); n -= r; }
    }
    private static void pad(InputStream in, long size) throws IOException {
        long r = size % 512;
        if (r != 0) { byte[] z = new byte[(int) (512 - r)]; readFully(in, z); }
    }
    private static boolean allZero(byte[] b) { for (byte x : b) if (x != 0) return false; return true; }
    private static long octal(byte[] b, int off, int len) {
        long v = 0;
        for (int i = off; i < off + len; i++) {
            int c = b[i];
            if (c == 0 || c == ' ') { if (v != 0) break; else continue; }
            v = v * 8 + (c - '0');
        }
        return v;
    }
    private static String cstr(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    static void write(File f, String s) throws IOException {
        try (OutputStream o = new FileOutputStream(f)) { o.write(s.getBytes(StandardCharsets.UTF_8)); }
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists() && !isSymlink(f)) return;
        if (f.isDirectory() && !isSymlink(f)) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        f.delete();
    }
    private static boolean isSymlink(File f) {
        try { return (Os.lstat(f.getPath()).st_mode & 0170000) == 0120000; }
        catch (Exception e) { return false; }
    }

    /** 统计已读字节，给进度条用 */
    private final class Counting extends InputStream {
        private final InputStream in; private final long total; private long done, lastTick;
        Counting(InputStream in, long total) { this.in = in; this.total = total; }
        @Override public int read() throws IOException { int b = in.read(); if (b >= 0) tick(1); return b; }
        @Override public int read(byte[] b, int o, int l) throws IOException { int n = in.read(b, o, l); if (n > 0) tick(n); return n; }
        private void tick(int n) {
            done += n;
            if (done - lastTick > (4 << 20) || done == total) { lastTick = done; ui.bytes(done, total); }
        }
        @Override public void close() throws IOException { in.close(); }
    }
}
