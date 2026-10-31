package com.junze.fntv;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.os.Build;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本机小服务：127.0.0.1 上跑一个只服务自己的 HTTP 服务。
 *
 * 存在的理由（跟桌面版 server.cjs 同一个理由）：
 *   1. 网页同源加载资源和接口，不用 file:// 那套 CORS 绕路
 *   2. 飞牛音乐的私有接口要 authx 签名 + music-token Cookie，这些在 Java 侧算完再转发
 *   3. 音频/封面走原样流式转发（含 Range），<audio> 才能边下边播、拖进度
 *
 * 只绑 127.0.0.1，局域网里别的设备连不上，等于没有对外端口。
 */
class LocalServer {

    private final Context ctx;
    private final AssetManager am;
    final FnApi api;
    private final SharedPreferences sp;

    private ServerSocket ss;
    private int port;
    private volatile boolean running;
    private final ExecutorService pool = Executors.newFixedThreadPool(8);
    /** 启动时的静默登录还没跑完时，网页来问 /api/session 就先等它一下，
     *  否则页面会比登录快一步，直接弹到登录页（明明密码都已经记住了）。 */
    private final java.util.concurrent.CountDownLatch loginGate = new java.util.concurrent.CountDownLatch(1);
    private volatile boolean autoLoginDone = false;

    /* ---------------- 诊断（排查电视上黑屏/白屏用） ----------------
       页面把“自己看到了什么”POST 到 127.0.0.1 的 /diag，这里存一份；
       同时在局域网上单开一个只读端口 8646，GET /diag 就能取到——
       电视上不用装任何调试工具，电脑上 curl 一下就能看到真相。 */
    private volatile String lastDiag = "";
    private volatile int lanPort = 0;
    private ServerSocket lanSs;
    static final int LAN_DIAG_PORT = 8646;

    LocalServer(Context c) {
        ctx = c;
        am = c.getAssets();
        api = new FnApi(c);
        sp = c.getSharedPreferences("fntv", Context.MODE_PRIVATE);
    }

    int getPort() { return port; }

    void start() throws IOException {
        ss = new ServerSocket(0, 30, InetAddress.getByName("127.0.0.1"));
        port = ss.getLocalPort();
        running = true;
        Thread t = new Thread(new Runnable() {
            public void run() { acceptLoop(); }
        }, "fn-local-accept");
        t.setDaemon(true);
        t.start();

        if (api.hasSaved()) {
            Thread w = new Thread(new Runnable() {
                public void run() {
                    try { api.login(api.base, api.user, api.pass, ""); }
                    finally { autoLoginDone = true; loginGate.countDown(); }
                }
            }, "fn-autologin");
            w.setDaemon(true);
            w.start();
        } else {
            autoLoginDone = true;
            loginGate.countDown();
        }

        startLanDiag();
    }

    /** 局域网只读诊断口：只认 GET /diag，别的路径一律 403 */
    private void startLanDiag() {
        try {
            lanSs = new ServerSocket(LAN_DIAG_PORT, 8);
            lanPort = lanSs.getLocalPort();
            Thread t = new Thread(new Runnable() {
                public void run() { lanLoop(); }
            }, "fn-lan-diag");
            t.setDaemon(true);
            t.start();
        } catch (Exception e) {
            lanPort = 0; // 端口被占就放弃，不影响主流程
        }
    }

    private void lanLoop() {
        while (running) {
            try {
                final Socket s = lanSs.accept();
                Thread t = new Thread(new Runnable() {
                    public void run() { handleLan(s); }
                }, "fn-lan-conn");
                t.setDaemon(true);
                t.start();
            } catch (Exception e) {
                if (!running) return;
            }
        }
    }

    private void handleLan(Socket s) {
        try {
            s.setSoTimeout(8000);
            InputStream in = s.getInputStream();
            String line = readLine(in);
            OutputStream out = new BufferedOutputStream(s.getOutputStream(), 8192);
            String path = "/";
            String query = "";
            if (line != null) {
                String[] p = line.split(" ");
                if (p.length > 1) {
                    String t = p[1];
                    int q = t.indexOf('?');
                    if (q >= 0) { path = t.substring(0, q); query = t.substring(q + 1); }
                    else path = t;
                }
            }
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n"
                    + "Access-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\n"
                    + "Connection: close\r\n\r\n").getBytes("UTF-8"));
            out.write(lanBody(path, query).getBytes("UTF-8"));
            out.flush();
            s.close();
        } catch (Exception e) {
            try { s.close(); } catch (Exception e2) {}
        }
    }

    /** 局域网调试控制台：/diag 看状态，/render 换渲染方式，/reload 重载，/key 模拟遥控器 */
    private String lanBody(String path, String query) {
        if (path.startsWith("/render")) {
            String m = q(query, "m");
            if (cmd != null) cmd.run("render", m);
            return "{\"ok\":true,\"render\":\"" + esc(m) + "\"}";
        }
        if (path.startsWith("/reload")) {
            if (cmd != null) cmd.run("reload", "");
            return "{\"ok\":true}";
        }
        if (path.startsWith("/key")) {
            String k = q(query, "k");
            if (cmd != null) cmd.run("key", k);
            return "{\"ok\":true,\"key\":\"" + esc(k) + "\"}";
        }
        if (path.startsWith("/diag") || path.equals("/")) {
            StringBuilder sb = new StringBuilder();
            sb.append("{\"device\":{");
            sb.append("\"model\":\"").append(esc(Build.MODEL)).append("\",");
            sb.append("\"brand\":\"").append(esc(Build.BRAND)).append("\",");
            sb.append("\"sdk\":").append(Build.VERSION.SDK_INT).append(",");
            sb.append("\"release\":\"").append(esc(Build.VERSION.RELEASE)).append("\"");
            sb.append("},\"server\":{\"port\":").append(port)
              .append(",\"lanPort\":").append(lanPort)
              .append(",\"connected\":").append(api.connected()).append("},\"page\":");
            String d = lastDiag;
            sb.append(d == null || d.length() == 0 ? "null" : d);
            sb.append("}");
            return sb.toString();
        }
        return "{\"ok\":false,\"msg\":\"unknown\",\"try\":[\"/diag\",\"/render?m=sw|hw|none\",\"/reload\",\"/key?k=left\"]}";
    }

    private static String q(String query, String key) {
        if (query == null || query.length() == 0) return "";
        for (String kv : query.split("&")) {
            int i = kv.indexOf('=');
            if (i > 0 && kv.substring(0, i).equals(key)) return kv.substring(i + 1);
        }
        return "";
    }

    /** 由 Activity 注入：render / reload / key */
    interface Cmd { void run(String name, String arg); }
    volatile Cmd cmd;

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /** 原生层往诊断箱里塞一句话（WebView 还没起来时也能看） */
    void note(String s) { lastDiag = s; }

    void stop() {
        running = false;
        try { if (ss != null) ss.close(); } catch (Exception e) {}
        try { if (lanSs != null) lanSs.close(); } catch (Exception e) {}
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket s = ss.accept();
                pool.execute(new Runnable() {
                    public void run() { handle(s); }
                });
            } catch (IOException e) {
                if (running) e.printStackTrace();
            }
        }
    }

    // ================= 请求处理 =================

    private void handle(Socket s) {
        try {
            s.setSoTimeout(30000);
            BufferedInputStream in = new BufferedInputStream(s.getInputStream(), 16384);
            String line = readLine(in);
            if (line == null || line.length() == 0) { s.close(); return; }

            String[] parts = line.split(" ");
            String method = parts.length > 0 ? parts[0].toUpperCase(Locale.US) : "GET";
            String target = parts.length > 1 ? parts[1] : "/";

            Map<String, String> headers = new HashMap<>();
            String h;
            while ((h = readLine(in)) != null && h.length() > 0) {
                int i = h.indexOf(':');
                if (i > 0) headers.put(h.substring(0, i).trim().toLowerCase(Locale.US), h.substring(i + 1).trim());
            }

            int cl = 0;
            try { cl = Integer.parseInt(headers.containsKey("content-length") ? headers.get("content-length") : "0"); } catch (Exception e) {}
            byte[] body = new byte[0];
            if (cl > 0) {
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int left = cl;
                while (left > 0) {
                    int n = in.read(buf, 0, Math.min(buf.length, left));
                    if (n <= 0) break;
                    bo.write(buf, 0, n);
                    left -= n;
                }
                body = bo.toByteArray();
            }

            String path = target;
            String query = "";
            int qi = target.indexOf('?');
            if (qi >= 0) { path = target.substring(0, qi); query = target.substring(qi + 1); }

            OutputStream out = new BufferedOutputStream(s.getOutputStream(), 32768);
            route(method, path, query, headers, body, out);
            out.flush();
            s.close();
        } catch (Exception e) {
            try { s.close(); } catch (Exception e2) {}
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') break;
            if (c != '\r') bo.write(c);
            if (bo.size() > 8192) break;
        }
        if (c < 0 && bo.size() == 0) return null;
        return new String(bo.toByteArray(), "UTF-8");
    }

    private void route(String method, String path, String query,
                       Map<String, String> headers, byte[] body, OutputStream out) throws IOException {

        // ---- 后端小接口 ----
        if (path.equals("/diag")) {
            if ("POST".equals(method)) {
                try { lastDiag = new String(body, "UTF-8"); } catch (Exception e) {}
            }
            sendJson(out, 200, lastDiag.length() > 0 ? lastDiag : "{}");
            return;
        }

        if (path.equals("/api/session")) {
            if (!autoLoginDone) {
                try { loginGate.await(6, java.util.concurrent.TimeUnit.SECONDS); } catch (Exception e) {}
            }
            JSONObject o = new JSONObject();
            try {
                o.put("connected", api.connected());
                o.put("username", api.user);
                o.put("savedUser", api.savedUser());
                o.put("savedBase", api.savedBase());
                o.put("hasSaved", api.hasSaved());
                o.put("lastTrack", lastTrack());
            } catch (Exception e) {}
            sendJson(out, 200, o.toString());
            return;
        }

        if (path.equals("/api/connect") && "POST".equals(method)) {
            JSONObject o = new JSONObject();
            try {
                JSONObject in = new JSONObject(new String(body, "UTF-8"));
                String b = FnApi.normalizeBase(in.optString("base", ""));
                String u = in.optString("username", "").trim();
                String p = in.optString("password", "");
                boolean remember = in.optBoolean("remember", true);
                if (b.length() == 0 || u.length() == 0 || p.length() == 0) {
                    o.put("code", -1);
                    o.put("msg", "地址、账号、密码都要填");
                } else {
                    String err = api.login(b, u, p, in.optString("accessCode", ""));
                    if (err == null) {
                        api.saveCred(b, u, p, remember);
                        o.put("code", 0);
                        JSONObject d = new JSONObject();
                        d.put("username", u);
                        o.put("data", d);
                    } else {
                        o.put("code", -1);
                        o.put("msg", err);
                    }
                }
            } catch (Exception e) {
                try { o.put("code", -1); o.put("msg", "请求解析失败"); } catch (Exception e2) {}
            }
            sendJson(out, 200, o.toString());
            return;
        }

        if (path.equals("/api/logout") && "POST".equals(method)) {
            api.forget();
            sendJson(out, 200, "{\"code\":0}");
            return;
        }

        if (path.equals("/api/progress")) {
            if ("POST".equals(method)) {
                try {
                    JSONObject in = new JSONObject(new String(body, "UTF-8"));
                    if (in.optString("guid", "").length() > 0) {
                        sp.edit().putString("lastTrack", in.toString()).apply();
                    }
                } catch (Exception e) {}
                sendJson(out, 200, "{\"code\":0}");
            } else {
                sendJson(out, 200, lastTrack().toString());
            }
            return;
        }

        if (path.equals("/api/prefs")) {
            if ("POST".equals(method)) {
                try {
                    JSONObject in = new JSONObject(new String(body, "UTF-8"));
                    sp.edit().putString("uiPrefs", in.toString()).apply();
                } catch (Exception e) {}
                sendJson(out, 200, "{\"code\":0}");
            } else {
                sendJson(out, 200, sp.getString("uiPrefs", "{}"));
            }
            return;
        }

        // ---- 代理到 NAS ----
        if (path.startsWith("/api/p/")) {
            proxy(method, path.substring("/api/p".length()), query, headers, body, out);
            return;
        }

        // ---- 静态资源 ----
        if (path.equals("/favicon.ico")) { send(out, 204, "image/x-icon", new byte[0], null); return; }
        // 1.0.4 修：网页资源全在 assets/www/ 下面，路径必须补 www/ 前缀。
        // 1.0.3 及以前只有 "/" 补了，/tv.js 被当成根目录下的 tv.js → 404 →
        // HTML 加载得出、脚本样式全灭，屏幕上就是"一片黑但页面加载完成"。
        String file = path.equals("/") ? "www/tv.html" : path.substring(1);
        if (file.endsWith("/")) file = file + "index.html";
        if (!file.startsWith("www/")) file = "www/" + file;
        if (file.indexOf("..") >= 0) { sendText(out, 404, "not found"); return; }
        serveAsset(file, out);
    }

    private JSONObject lastTrack() {
        try {
            String s = sp.getString("lastTrack", "");
            if (s != null && s.length() > 0) return new JSONObject(s);
        } catch (Exception e) {}
        return new JSONObject();
    }

    private void serveAsset(String name, OutputStream out) throws IOException {
        String ctype = "application/octet-stream";
        if (name.endsWith(".html")) ctype = "text/html; charset=utf-8";
        else if (name.endsWith(".css")) ctype = "text/css; charset=utf-8";
        else if (name.endsWith(".js")) ctype = "application/javascript; charset=utf-8";
        else if (name.endsWith(".png")) ctype = "image/png";
        else if (name.endsWith(".svg")) ctype = "image/svg+xml";
        else if (name.endsWith(".woff2")) ctype = "font/woff2";
        InputStream in = null;
        try {
            in = am.open(name);
        } catch (Exception e) {
            sendText(out, 404, "not found: " + name);
            return;
        }
        byte[] data = FnApi.readAll(in).getBytes("UTF-8");
        // readAll 按 UTF-8 转换，二进制资源必须原样拷贝
        if (!ctype.startsWith("text") && !ctype.startsWith("application/javascript")) {
            in = am.open(name);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            data = bo.toByteArray();
        }
        Map<String, String> extra = new LinkedHashMap<>();
        extra.put("Cache-Control", "no-cache");
        send(out, 200, ctype, data, extra);
    }

    // ================= 上游代理 =================

    private void proxy(String method, String upstreamPath, String query,
                       Map<String, String> headers, byte[] body, OutputStream out) throws IOException {

        if (!api.connected()) {
            sendJson(out, 401, "{\"code\":120001,\"msg\":\"未登录\"}");
            return;
        }

        Map<String, String> q = FnApi.parseQuery(query);
        String pathname = FnApi.API_BASE + upstreamPath;
        boolean isStream = upstreamPath.contains("track/stream") || upstreamPath.contains("static/cover");
        String bodyStr = body.length > 0 ? new String(body, "UTF-8") : null;

        HttpURLConnection c = open(method, pathname, query, q, bodyStr, headers, body);
        // 列表/搜索/歌词这类接口必须有超时，不然 NAS 卡住会把这一条连接吊死
        if (!isStream) c.setReadTimeout(20000);

        // 非流式：先看是不是 token 过期，过期就重登重试一次
        if (!isStream) {
            int code = c.getResponseCode();
            byte[] data = FnApi.readAll(code >= 400 ? c.getErrorStream() : c.getInputStream()).getBytes("UTF-8");
            boolean expired = code == 401;
            if (!expired && data.length > 0) {
                try {
                    JSONObject j = new JSONObject(new String(data, "UTF-8"));
                    int jc = j.optInt("code", 0);
                    if (jc == 120001 || jc == 99999) expired = true;
                } catch (Exception e) {}
            }
            if (expired && api.pass.length() > 0) {
                if (api.login(api.base, api.user, api.pass, "") == null) {
                    try {
                        HttpURLConnection c2 = open(method, pathname, query, q, bodyStr, headers, body);
                        int code2 = c2.getResponseCode();
                        data = FnApi.readAll(code2 >= 400 ? c2.getErrorStream() : c2.getInputStream()).getBytes("UTF-8");
                        String ct = c2.getContentType();
                        Map<String, String> extra = new LinkedHashMap<>();
                        if (ct != null) extra.put("Content-Type", ct);
                        extra.put("Cache-Control", "no-cache");
                        send(out, code2, ct == null ? "application/json; charset=utf-8" : ct, data, extra);
                        return;
                    } catch (Exception e) {}
                }
            }
            String ct = c.getContentType();
            Map<String, String> extra = new LinkedHashMap<>();
            extra.put("Cache-Control", "no-cache");
            send(out, code, ct == null ? "application/json; charset=utf-8" : ct, data, extra);
            return;
        }

        // 流式（音频/封面）：状态码 + 关键头原样透传，body 边读边发
        int code = c.getResponseCode();
        String ct = c.getContentType();
        String sb = new StringBuilder("HTTP/1.1 ").append(code).append(' ').append(statusText(code)).append("\r\n").toString();
        StringBuilder hd = new StringBuilder();
        hd.append("Content-Type: ").append(ct == null ? "application/octet-stream" : ct).append("\r\n");
        hd.append("Accept-Ranges: bytes\r\n");
        String range = c.getHeaderField("Content-Range");
        if (range != null) hd.append("Content-Range: ").append(range).append("\r\n");
        long len = -1;
        String clh = c.getHeaderField("Content-Length");
        if (clh != null) {
            try { len = Long.parseLong(clh); } catch (Exception e) {}
        }
        if (len >= 0) hd.append("Content-Length: ").append(len).append("\r\n");
        hd.append("Cache-Control: no-cache\r\n");
        hd.append("Connection: close\r\n\r\n");
        out.write(sb.getBytes("UTF-8"));
        out.write(hd.toString().getBytes("UTF-8"));
        out.flush();

        InputStream in = null;
        try {
            in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    out.flush();
                }
            }
        } catch (Exception e) {
            // 客户端断开（换歌了）是常态，不用管
        } finally {
            try { if (in != null) in.close(); } catch (Exception e) {}
            try { c.disconnect(); } catch (Exception e) {}
        }
    }

    private HttpURLConnection open(String method, String pathname, String query,
                                   Map<String, String> q, String bodyStr,
                                   Map<String, String> reqHeaders, byte[] body) throws IOException {
        String url = api.base + pathname + (query != null && query.length() > 0 ? "?" + query : "");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000);
        c.setReadTimeout(0);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("Accept", "application/json, */*");
        c.setRequestProperty("Accept-Language", "zh-CN");
        c.setRequestProperty("User-Agent", reqHeaders.containsKey("user-agent") ? reqHeaders.get("user-agent") : "fnmusic-tv/1.0");
        c.setRequestProperty("authx", api.makeAuthx(method, pathname, q, bodyStr));
        if (api.token.length() > 0) c.setRequestProperty("Cookie", "music-token=" + FnApi.enc(api.token));
        String r = reqHeaders.get("range");
        if (r != null) c.setRequestProperty("Range", r);
        if (body.length > 0) {
            c.setDoOutput(true);
            String ct = reqHeaders.get("content-type");
            c.setRequestProperty("Content-Type", ct == null ? "application/json" : ct);
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.close();
        }
        return c;
    }

    // ================= 输出 =================

    private static String statusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 416: return "Range Not Satisfiable";
            case 500: return "Internal Server Error";
            case 502: return "Bad Gateway";
            default: return "OK";
        }
    }

    private void sendJson(OutputStream out, int code, String json) throws IOException {
        Map<String, String> extra = new LinkedHashMap<>();
        extra.put("Cache-Control", "no-cache");
        send(out, code, "application/json; charset=utf-8", json.getBytes("UTF-8"), extra);
    }

    private void sendText(OutputStream out, int code, String text) throws IOException {
        send(out, code, "text/plain; charset=utf-8", text.getBytes("UTF-8"), null);
    }

    private void send(OutputStream out, int code, String ctype, byte[] body, Map<String, String> extra) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(code).append(' ').append(statusText(code)).append("\r\n");
        sb.append("Content-Type: ").append(ctype).append("\r\n");
        sb.append("Content-Length: ").append(body.length).append("\r\n");
        sb.append("Connection: close\r\n");
        if (extra != null) {
            for (Map.Entry<String, String> e : extra.entrySet()) {
                sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
        }
        sb.append("\r\n");
        out.write(sb.toString().getBytes("UTF-8"));
        out.write(body);
    }
}
