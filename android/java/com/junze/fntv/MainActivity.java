package com.junze.fntv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.TypedValue;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * TV 端外壳：一个 WebView + 遥控器按键翻译。
 *
 * 遥控器规则（默认播放态）：
 *   ← / →  上一曲 / 下一曲
 *   ↑      进曲库（进去之后方向键变成"选歌"，不再切歌）
 *   ↓      功能菜单（皮肤 / 配色 / 播放模式 / 进度）
 *   OK     播放 / 暂停
 *   音量键 系统媒体音量（页面弹一个音量条）
 *   返回   退出面板；在播放页连按两次退出应用
 *
 * 1.0.3 针对"投影仪上全黑、但按键有反应"重做了渲染：
 *   - 清单里关掉硬件加速，WebView 再显式压到软件层（电视盒子 GPU 驱动是黑屏头号原因）
 *   - 原生诊断条改成"页面自己报数"：内核版本 / CSS 变量支持 / 舞台尺寸 / 页面文字，
 *     全部走 JsBridge 回传，哪怕网页一个像素都画不出来，这条也能显示
 */
public class MainActivity extends Activity {

    private WebView web;
    private LocalServer server;
    private AudioManager am;
    private LinearLayout tip;       // 原生诊断面板：坐在 WebView 上面，证明"这一层到底能不能画"
    private TextView tipTitle;
    private TextView tipBody;
    private String page = "player";
    private long lastBack = 0;
    private long lastNav = 0;

    /* 长按左右键 = 连续快退/快进。
       判定方式：按下后先不切歌，等 450ms 还没松手才进入"连续 seek"模式；
       松手时如果从没进入过 seek，才算一次单击（上一曲/下一曲）。 */
    private final Handler uiH = new Handler(Looper.getMainLooper());
    private boolean holdFiredL = false, holdFiredR = false;
    private final Runnable holdL = new Runnable() {
        public void run() {
            holdFiredL = true;
            key("seek-back");
            uiH.postDelayed(this, 220);
        }
    };
    private final Runnable holdR = new Runnable() {
        public void run() {
            holdFiredR = true;
            key("seek-fwd");
            uiH.postDelayed(this, 220);
        }
    };
    private boolean tipPinned = false;
    private ToneGenerator tone;   // 按键音：遥控器没反馈很难盲操作

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
        }
        hideSystemUi();

        am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#081120"));
        setContentView(root);   // 先把容器挂上去，后面哪一步炸了都还能往上贴字

        // ============ 0) 局域网诊断口最先起来 ============
        try {
            server = new LocalServer(this);
            server.cmd = new LocalServer.Cmd() {
                public void run(String name, String arg) {
                    if ("reload".equals(name)) {
                        runOnUiThread(new Runnable() { public void run() { if (web != null) web.reload(); } });
                    } else if ("key".equals(name)) {
                        final String k = arg;
                        runOnUiThread(new Runnable() { public void run() { key(k); } });
                    } else if ("render".equals(name)) {
                        final String m = arg;
                        runOnUiThread(new Runnable() { public void run() { setRender(m); } });
                    }
                }
            };
            server.start();
            note("server up, port=" + server.getPort());
        } catch (Throwable t) {
            server = null;
            Toast.makeText(this, "本地服务没起来：" + t, Toast.LENGTH_LONG).show();
        }

        // ============ 1) WebView（失败也不许崩） ============
        try {
            web = new WebView(this);
            WebSettings st = web.getSettings();
            st.setJavaScriptEnabled(true);
            st.setDomStorageEnabled(true);
            st.setDatabaseEnabled(true);
            st.setMediaPlaybackRequiresUserGesture(false);   // 遥控器不算"用户手势"，必须放开
            st.setAllowFileAccess(false);
            st.setAllowContentAccess(false);
            st.setLoadsImagesAutomatically(true);
            st.setUseWideViewPort(true);
            st.setLoadWithOverviewMode(true);
            st.setCacheMode(WebSettings.LOAD_NO_CACHE);
            st.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

            web.setBackgroundColor(Color.parseColor("#081120"));
            web.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, String url) {
                    return !url.startsWith("http://127.0.0.1");
                }
                @Override
                public void onPageFinished(WebView v, String url) {
                    if (tipPinned) return;
                    append("页面已加载完成");
                    // 页面脚本到底跑没跑，别靠猜：直接注入一句问它
                    try {
                        v.evaluateJavascript(
                                "(function(){var s=document.getElementById('stage');return JSON.stringify({TV:typeof window.TV,css:document.styleSheets.length,js:document.scripts.length,stageKids:s?s.children.length:-1});})()",
                                new android.webkit.ValueCallback<String>() {
                                    public void onReceiveValue(String val) {
                                        append("探测 " + String.valueOf(val).replace("\\\"", "\""));
                                    }
                                });
                    } catch (Throwable t) {
                        append("探测失败 " + t);
                    }
                }
                @Override
                public void onReceivedError(WebView v, int code, String desc, String url) {
                    append("加载出错 " + code + " " + desc);
                }
            });
            web.setWebChromeClient(new WebChromeClient());
            // 1.0.5：1.0.4 已证明页面数据全对（stage 铺满、渐变生效、JS 在跑），
            // 但屏幕上一个像素都没有 → 就是合成层。压到软件层，绕开 GPU。
            web.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
            web.addJavascriptInterface(new JsBridge(), "FnTV");

            root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        } catch (Throwable t) {
            web = null;
            status("WebView 起不来", "异常：" + t, 0xFFFF6B6B);
        }

        // ============ 2) 原生诊断面板：最后加 = 盖在最上层 ============
        buildTip(root);
        root.addView(tip, tipParams());
        status("飞牛音乐TV 1.0.8 · 原生层 OK",
                "WebView " + chromeVer() + " · Android " + Build.VERSION.RELEASE
                        + " · " + screenInfo() + "\n正在加载页面…", 0xFF39FF88);

        if (web != null && server != null) {
            try {
                web.loadUrl("http://127.0.0.1:" + server.getPort() + "/");
            } catch (Throwable t) {
                append("加载失败：" + t);
            }
        }
        Toast.makeText(this, "飞牛音乐 TV 启动中…", Toast.LENGTH_SHORT).show();

        // 6 秒后如果页面还没报到，把能拿到的都补上去
        new android.os.Handler(getMainLooper()).postDelayed(new Runnable() {
            public void run() { if (!tipPinned) append("6 秒仍未收到页面回报"); }
        }, 6000);
    }

    private void buildTip(FrameLayout root) {
        tip = new LinearLayout(this);
        tip.setOrientation(LinearLayout.VERTICAL);
        tip.setBackgroundColor(0xF0000000);
        tip.setPadding(dp(26), dp(18), dp(26), dp(20));

        tipTitle = new TextView(this);
        tipTitle.setTextColor(0xFF39FF88);
        tipTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        tip.addView(tipTitle);

        tipBody = new TextView(this);
        tipBody.setTextColor(0xFFD8F5E4);
        tipBody.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        tipBody.setPadding(0, dp(8), 0, 0);
        tipBody.setLineSpacing(dp(3), 1f);
        tip.addView(tipBody);
    }

    private FrameLayout.LayoutParams tipParams() {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-1, -2);
        lp.leftMargin = dp(20);
        lp.rightMargin = dp(20);
        lp.topMargin = dp(16);
        lp.gravity = Gravity.TOP;
        return lp;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void status(String title, String body, int color) {
        if (tip == null) return;
        tipTitle.setText(title);
        tipTitle.setTextColor(color);
        tipBody.setText(body);
        tip.setVisibility(View.VISIBLE);
    }

    /** 往诊断面板末尾追一行（保留历史，方便一眼看出卡在哪一步） */
    private void append(String line) {
        if (tipBody == null) return;
        String old = tipBody.getText() == null ? "" : tipBody.getText().toString();
        if (old.length() > 900) old = old.substring(old.length() - 700);
        tipBody.setText(old.length() == 0 ? line : old + "\n" + line);
        tip.setVisibility(View.VISIBLE);
    }

    private String chromeVer() {
        try {
            if (web == null) return "无";
            String ua = web.getSettings().getUserAgentString();
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("Chrome/([0-9.]+)").matcher(ua == null ? "" : ua);
            if (m.find()) return m.group(1);
            return "非Chromium";
        } catch (Throwable t) {
            return "?";
        }
    }

    private String screenInfo() {
        try {
            android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
            return dm.widthPixels + "x" + dm.heightPixels + "@" + dm.densityDpi + "dpi";
        } catch (Throwable t) {
            return "?";
        }
    }

    private void note(String s) {
        if (server != null) server.note("{\"native\":\"" + s.replace("\"", "'") + "\"}");
    }

    /** 按一下给个短促的"哒"，让手知道按到了 */
    private void click() {
        try {
            if (tone == null) tone = new ToneGenerator(AudioManager.STREAM_MUSIC, 45);
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, 14);
        } catch (Throwable t) { /* 没声音也不能影响按键 */ }
    }

    private void hideSystemUi() {
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        if (has) hideSystemUi();
    }

    // ================= 遥控器 =================

    private void js(String code) {
        if (web == null) return;
        web.evaluateJavascript(code, null);
    }

    private void key(String name) {
        js("window.TV && TV.key('" + name + "')");
    }

    /** hw / sw / none —— 现场换渲染方式，黑屏时逐档试 */
    private void setRender(String mode) {
        if (web == null) return;
        if ("sw".equals(mode)) web.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        else if ("none".equals(mode)) web.setLayerType(View.LAYER_TYPE_NONE, null);
        else if ("hw".equals(mode)) web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        web.invalidate();
        Toast.makeText(this, "渲染方式：" + mode, Toast.LENGTH_SHORT).show();
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        boolean repeat = e.getRepeatCount() > 0;
        long now = System.currentTimeMillis();

        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP:
                if (repeat && now - lastNav < 120) return true;
                lastNav = now;
                click();
                key("up");
                return true;
            case KeyEvent.KEYCODE_DPAD_DOWN:
                if (repeat && now - lastNav < 120) return true;
                lastNav = now;
                click();
                key("down");
                return true;
            case KeyEvent.KEYCODE_DPAD_LEFT:
                if (repeat) return true;              // 系统重复交给自己的循环，别重复触发
                if (playerPage()) {
                    click();
                    holdFiredL = false;
                    uiH.removeCallbacks(holdL);
                    uiH.postDelayed(holdL, 450);
                    return true;
                }
                if (now - lastNav < 120) return true;
                lastNav = now;
                click();
                key("left");
                return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (repeat) return true;
                if (playerPage()) {
                    click();
                    holdFiredR = false;
                    uiH.removeCallbacks(holdR);
                    uiH.postDelayed(holdR, 450);
                    return true;
                }
                if (now - lastNav < 120) return true;
                lastNav = now;
                click();
                key("right");
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK:
                if (repeat) return true;
                click();
                key("ok");
                return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                key("next");
                return true;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                key("prev");
                return true;
            case KeyEvent.KEYCODE_MEDIA_STOP:
                key("ok");
                return true;

            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_INFO:
                // 菜单键 = 钉住/收起诊断面板
                if (repeat) return true;
                tipPinned = !tipPinned;
                if (tipPinned) {
                    tip.setVisibility(View.VISIBLE);
                    js("window.TV && TV.diag && TV.diag()");
                } else {
                    tip.setVisibility(View.GONE);
                }
                return true;

            case KeyEvent.KEYCODE_VOLUME_UP:
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, 0);
                reportVolume();
                return true;
            case KeyEvent.KEYCODE_VOLUME_DOWN:
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, 0);
                reportVolume();
                return true;
            case KeyEvent.KEYCODE_VOLUME_MUTE:
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, 0);
                reportVolume();
                return true;

            case KeyEvent.KEYCODE_BACK:
                if (repeat) return true;
                click();
                if (tipPinned) { tipPinned = false; tip.setVisibility(View.GONE); return true; }
                if (!"player".equals(page)) {
                    key("back");
                    return true;
                }
                if (now - lastBack < 2000) {
                    js("window.TV && TV.beforeExit && TV.beforeExit()");
                    finish();
                } else {
                    lastBack = now;
                    js("window.TV && TV.toast && TV.toast('再按一次返回退出')");
                }
                return true;
        }
        return super.onKeyDown(code, e);
    }

    /** 只有播放页才有"长按快进"；曲库/菜单里左右键还是移动焦点 */
    private boolean playerPage() {
        return "player".equals(page);
    }

    @Override
    public boolean onKeyUp(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT) {
            boolean isL = code == KeyEvent.KEYCODE_DPAD_LEFT;
            Runnable r = isL ? holdL : holdR;
            uiH.removeCallbacks(r);
            if (!playerPage()) return true;          // 非播放页：按下时已经发过了
            boolean fired = isL ? holdFiredL : holdFiredR;
            if (isL) holdFiredL = false; else holdFiredR = false;
            if (!fired) key(isL ? "left" : "right"); // 单击：上一曲 / 下一曲
            return true;
        }
        return super.onKeyUp(code, e);
    }

    private void reportVolume() {
        int cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        js("window.TV && TV.vol && TV.vol(" + cur + "," + max + ")");
    }

    // ================= 页面 → 原生 =================

    /** addJavascriptInterface 走反射，类必须是 public、方法必须带 @JavascriptInterface */
    public class JsBridge {
        @JavascriptInterface
        public void page(String name) {
            page = name == null ? "player" : name;
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show(); }
            });
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(new Runnable() {
                public void run() { finish(); }
            });
        }

        @JavascriptInterface
        public void volume(final int v) {
            runOnUiThread(new Runnable() {
                public void run() {
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, v, 0);
                    reportVolume();
                }
            });
        }

        @JavascriptInterface
        public void render(final String mode) {
            runOnUiThread(new Runnable() {
                public void run() { setRender(mode); }
            });
        }

        @JavascriptInterface
        public String build() { return "fntv-1.0.8"; }

        /** 页面在早期抛的错 / 资源 404，全部直接贴到原生面板上 */
        @JavascriptInterface
        public void log(final String msg) {
            runOnUiThread(new Runnable() {
                public void run() { append(String.valueOf(msg)); }
            });
        }

        /**
         * 页面把自检结果整段送上来。这里是黑屏排查的命门：
         * 哪怕网页一个像素都没画出来，这段字也是原生控件画的，一定看得见。
         */
        @JavascriptInterface
        public void probe(final String json) {
            runOnUiThread(new Runnable() {
                public void run() {
                    if (tipPinned) {   // 用户按过菜单键要一直看，就别收
                        status("页面自检回报（1.0.8）", fmtJson(json), 0xFF39FF88);
                        return;
                    }
                    status("页面自检回报（1.0.8）", fmtJson(json), 0xFF39FF88);
                    // 6 秒后自己收：界面要是能画出来，别让这块黑布挡着
                    new android.os.Handler(getMainLooper()).postDelayed(new Runnable() {
                        public void run() {
                            if (!tipPinned && tip != null) tip.setVisibility(View.GONE);
                        }
                    }, 6000);
                }
            });
        }

        /** 页面 JS 跑起来了 */
        @JavascriptInterface
        public void ready() {
            runOnUiThread(new Runnable() {
                public void run() {
                    if (tipPinned) return;
                    append("页面 JS 已就绪");
                    // 界面正常的话不该老挡着，10 秒自己收；要看就按菜单键
                    new android.os.Handler(getMainLooper()).postDelayed(new Runnable() {
                        public void run() {
                            if (!tipPinned && tip != null) tip.setVisibility(View.GONE);
                        }
                    }, 10000);
                }
            });
        }
    }

    /** 把页面送上来的 JSON 拍平成好读的多行文字 */
    private String fmtJson(String json) {
        if (json == null) return "(空)";
        StringBuilder sb = new StringBuilder();
        try {
            org.json.JSONObject o = new org.json.JSONObject(json);
            java.util.Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                sb.append(k).append("：").append(String.valueOf(o.opt(k))).append('\n');
            }
        } catch (Throwable t) {
            sb.append(json);
        }
        return sb.toString().trim();
    }

    @Override
    public void onBackPressed() {
        onKeyDown(KeyEvent.KEYCODE_BACK, new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK));
    }

    @Override
    protected void onDestroy() {
        try { if (tone != null) { tone.release(); tone = null; } } catch (Exception e) {}
        try { if (server != null) server.stop(); } catch (Exception e) {}
        try { if (web != null) { web.loadUrl("about:blank"); web.destroy(); } } catch (Exception e) {}
        super.onDestroy();
    }
}
