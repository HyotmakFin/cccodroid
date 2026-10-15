package cc.codroid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 网关的宿主。为什么要它：
 *   普通应用一进后台，几分钟内就会被冻结或回收，跑到一半的 claude 跟着没了。
 *   前台服务 + 常驻通知让系统把我们当"用户正在用的东西"；部分唤醒锁让锁屏后 CPU 不睡；
 *   网关是本服务的子进程 —— 服务活着，它就活着；它自己挂了，这里按退避重新拉起。
 */
public class GatewayService extends Service {
    static final String TAG = "cccodroid";
    static final String CH = "gateway";
    static final String ACTION_STOP = "cc.codroid.STOP";
    static final String ACTION_BOOT = "cc.codroid.BOOT";

    /** 替换工具包期间停住网关（它跑的 node 就在要被换掉的目录里） */
    private static volatile boolean paused;
    private static volatile GatewayService self;
    static void pause(boolean on) {
        paused = on;
        GatewayService s = self;
        if (on && s != null) s.killGateway();
    }

    private Env env;
    private Process proc;
    private PowerManager.WakeLock wake;
    private volatile boolean stopping;
    private Thread supervisor;

    static void start(Context c) {
        Intent i = new Intent(c, GatewayService.class);
        c.startForegroundService(i);
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        env = new Env(this);
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH, "后台运行", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("保持网关与正在进行的任务在后台运行");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        startForeground(1, note("正在启动…"));

        PowerManager pm = getSystemService(PowerManager.class);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cccodroid:gateway");
        wake.setReferenceCounted(false);
        wake.acquire();

        // 提权中转：和网关同寿命（priv 命令、设置页的 Shizuku 状态都靠它）
        Priv.start(this);
        self = this;
        Updater.get(this).loop();
        // Shizuku 掉了（重启、被杀）而用户开着自动激活：自己重新拉起来
        ShizukuSetup.get(this).reactivateAsync(false);
        watchFreeze();
        // 后台时的完成 / 等确认通知：订阅网关事件流（界面关了也照发）
        Notify.get(this).start();
    }

    /**
     * 冻结检测：每 2 秒醒一次，uptime 跳得远说明 CPU 醒着而我们没在跑 —— 被系统冻住了
     * （深睡时 uptime 不走，不会误报）。前台服务挡不住厂商冻结器：实测红魔在后台 90 秒冻结整个进程组，
     * 网关和正在跑的任务全停。记下来，设置页据此提示用户去系统里允许后台运行。
     */
    private void watchFreeze() {
        Thread t = new Thread(() -> {
            android.content.SharedPreferences sp = getSharedPreferences("bg", MODE_PRIVATE);
            while (!stopping) {
                long t0 = android.os.SystemClock.uptimeMillis();
                sleep(2000);
                long gap = android.os.SystemClock.uptimeMillis() - t0 - 2000;
                if (gap > 15_000) {
                    Log.w(TAG, "被冻结了约 " + gap / 1000 + " 秒");
                    // 空闲时被冻无害，只记跑任务时的那种（标记文件由网关在任务开始/结束时增删）
                    if (!new File(env.home, ".run-active").exists()) continue;
                    sp.edit().putLong("frozenAt", System.currentTimeMillis()).putLong("frozenMs", gap)
                        .putInt("frozenCount", sp.getInt("frozenCount", 0) + 1).apply();
                }
            }
        }, "freeze-watch");
        t.setDaemon(true);
        t.start();
    }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        if (i != null && ACTION_STOP.equals(i.getAction())) {
            stopping = true;
            killGateway();
            ShizukuSetup.get(this).onExit();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (i != null && ACTION_BOOT.equals(i.getAction())) ShizukuSetup.get(this).reactivateAsync(true);
        if (supervisor == null || !supervisor.isAlive()) {
            supervisor = new Thread(this::supervise, "gateway-supervisor");
            supervisor.start();
        }
        // 被系统回收后自动重建（Android 会带空 intent 重启服务）
        return START_STICKY;
    }

    @Override public void onDestroy() {
        if (self == this) self = null;
        stopping = true;
        Notify.get(this).stop();
        killGateway();
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }

    /** 守护循环：网关退出就重拉；连续快速崩溃时退避，别把电池耗光 */
    private void supervise() {
        long backoff = 1000;
        while (!stopping) {
            if (paused) { update("正在更新开发工具包…"); sleep(1000); continue; }
            if (!env.devkitReady()) { update("工具链未安装"); sleep(3000); continue; }
            if (alive()) { update("运行中 · 127.0.0.1:" + Env.PORT); sleep(5000); continue; }
            long t0 = System.currentTimeMillis();
            try {
                spawnGateway();
                update("运行中 · 127.0.0.1:" + Env.PORT);
                int rc = proc.waitFor();
                Log.w(TAG, "网关退出 rc=" + rc);
            } catch (Exception e) {
                Log.e(TAG, "网关启动失败", e);
            }
            if (stopping) break;
            backoff = System.currentTimeMillis() - t0 > 60000 ? 1000 : Math.min(backoff * 2, 60000);
            update("网关已退出，" + (backoff / 1000) + " 秒后重启");
            sleep(backoff);
        }
    }

    private void spawnGateway() throws Exception {
        File server = new File(env.app, "server.mjs");
        ProcessBuilder pb = new ProcessBuilder(env.bin("node").getPath(), server.getPath(), String.valueOf(Env.PORT));
        env.apply(pb.environment());
        pb.directory(env.app);
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(new File(env.home, "gateway.out")));
        proc = pb.start();
    }

    private void killGateway() {
        Process p = proc;
        if (p == null) return;
        // SIGTERM 让网关自己收尾（它会连带杀掉正在跑的 claude 进程树）
        p.destroy();
        try { if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly(); } catch (InterruptedException ignored) {}
    }

    /** 端口上已经有活的网关（比如服务重建前留下的那个）就别再起一个 */
    private boolean alive() {
        if (proc != null && proc.isAlive()) return true;
        try {
            HttpURLConnection c = Env.gateway("/api/status");
            c.setConnectTimeout(800); c.setReadTimeout(1500);
            return c.getResponseCode() == 200;
        } catch (Exception e) { return false; }
    }

    private String last;
    private void update(String text) {
        if (text.equals(last)) return;
        last = text;
        getSystemService(NotificationManager.class).notify(1, note(text));
    }

    private Notification note(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, GatewayService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CH)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("cccodroid")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, "停止", stop).build())
            .build();
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
