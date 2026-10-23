package cc.codroid;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import java.io.File;
import java.net.HttpURLConnection;
import java.nio.file.Files;

/**
 * 定时任务的系统闹钟。网关只在自己活着时准点（每 30 秒查一次）；应用被系统杀掉、或机器深睡时会错过。
 * 网关把最近一次要跑的时刻报过来（事件 sched_next，启动时读 home/ccapp-sched-next），这里定一个
 * setExactAndAllowWhileIdle 闹钟：到点拉起网关服务，再调 /api/sched/tick 让它立刻查一遍。
 * targetSdk 28：安卓 12 起的「精确闹钟要授权」「后台不许启动前台服务」都不约束我们，不用引导用户去开。
 */
public class SchedAlarm extends BroadcastReceiver {
    static final String TAG = "cccodroid";
    static final String ACTION = "cc.codroid.SCHED_ALARM";
    private static long lastAt = -1;

    private static PendingIntent pi(Context c) {
        Intent i = new Intent(c, SchedAlarm.class).setAction(ACTION);
        return PendingIntent.getBroadcast(c, 70, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** at：毫秒时间戳，0 = 没有要跑的，取消闹钟 */
    static synchronized void set(Context c, long at) {
        if (at == lastAt) return;
        lastAt = at;
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent p = pi(c);
        if (at <= 0) { am.cancel(p); Log.i(TAG, "定时任务闹钟：已取消"); return; }
        try {
            boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
            if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p);
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p);
            Log.i(TAG, "定时任务闹钟：" + new java.util.Date(at) + (exact ? "（精确）" : "（非精确）"));
        } catch (Exception e) {
            Log.w(TAG, "定时任务闹钟设置失败", e);
        }
    }

    /** 网关写的 home/ccapp-sched-next（服务启动、事件流重连时补一次，免得漏掉事件） */
    static void fromFile(Context c) {
        try {
            File f = new File(new Env(c).home, "ccapp-sched-next");
            if (!f.exists()) return;
            set(c, Long.parseLong(new String(Files.readAllBytes(f.toPath()), "UTF-8").trim()));
        } catch (Exception e) {
            Log.w(TAG, "定时任务闹钟：读文件失败", e);
        }
    }

    @Override public void onReceive(Context c, Intent i) {
        if (!ACTION.equals(i.getAction())) return;
        Log.i(TAG, "定时任务闹钟响了");
        synchronized (SchedAlarm.class) { lastAt = -1; }   // 已经响过，下次报来的同一时刻也要重新定
        try { GatewayService.start(c); } catch (Exception e) { Log.w(TAG, "定时任务闹钟：拉起服务失败", e); }
        // 挂住广播（后台广播最多约 60 秒）：等网关能接请求了让它立刻查一遍；网关刚启动的话它 5 秒后也会自己查
        PendingResult pr = goAsync();
        new Thread(() -> {
            try {
                for (int n = 0; n < 20; n++) {
                    try {
                        HttpURLConnection h = Env.gateway("/api/sched/tick");
                        h.setRequestMethod("POST");
                        h.setConnectTimeout(2000); h.setReadTimeout(5000);
                        int code = h.getResponseCode();
                        h.disconnect();
                        if (code == 200) { Log.i(TAG, "定时任务闹钟：网关已查过"); return; }
                    } catch (Exception ignored) {}
                    try { Thread.sleep(2500); } catch (InterruptedException e) { return; }
                }
            } finally { pr.finish(); }
        }, "sched-alarm").start();
    }
}
