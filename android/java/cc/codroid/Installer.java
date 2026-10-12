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
import java.util.zip.GZIPInputStream;

/** 首次安装：把 devkit tar 解到 files/ 下、跑 first-run、再装官方 Claude Code。全程只写本应用私有目录。 */
final class Installer {
    interface Progress { void step(String msg); void bytes(long done, long total); }

    private final Env env;
    private final Progress ui;

    Installer(Env env, Progress ui) { this.env = env; this.ui = ui; }

    // ── devkit ─────────────────────────────────────────────────────────
    void installDevkit(String source) throws IOException {
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
        InputStream s = source.endsWith(".gz") ? new GZIPInputStream(in, 1 << 16) : in;
        File tmp = new File(env.files, "usr.new");
        deleteTree(tmp);
        tmp.mkdirs();
        // tar 里的条目都以 usr/ 开头：解到 files/usr.new/ 下再整体换名，失败不留半成品
        untar(s, tmp, "usr/");
        s.close();
        deleteTree(env.usr);
        if (!tmp.renameTo(env.usr)) throw new IOException("换名失败: " + tmp);
        new File(env.usr, "tmp").mkdirs();
        env.home.mkdirs();

        ui.step("首次运行配置…");
        int rc = run(env.bin("bash").getPath(), new File(env.usr, "libexec/devkit/first-run.sh").getPath());
        if (rc != 0) ui.step("（first-run 返回 " + rc + "，不影响使用）");
        // Guile 的编译缓存必须比源码新（哪怕包里两者同一秒），否则 gdb 启动时陷入重编译死循环
        run(env.bin("bash").getPath(), "-c", "find \"$PREFIX/lib/guile\" -name '*.go' -exec touch {} + 2>/dev/null; true");
        writeResolvConf();
        write(new File(env.usr, ".devkit-ok"), "ok\n");
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

    private int run(String... cmd) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        env.apply(pb.environment());
        pb.directory(env.home);
        pb.redirectErrorStream(true);
        Process p = pb.start();
        BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
        for (String l; (l = r.readLine()) != null; ) ui.step(l);
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
