package com.junze.fntv;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * 飞牛音乐私有 API 客户端。
 *
 * 和桌面版 server.cjs 一一对应：authx 签名（前缀明文 + clientKey 与 md5 混算）、
 * music-token 会话、password-login（密码先 sha256 再提交）。
 * 全部在 Java 侧完成，网页只认 /api/p/xxx 这类同源地址。
 */
class FnApi {

    /* 签名常量：来自飞牛音乐前端。开源版本不内置，改为运行时从 assets/fn_config.json 读取，
       避免把逆向成果直接公开。构建前把 fn_config.example.json 复制成 fn_config.json 填入自己的值，
       fn_config.json 已在 .gitignore 里，不会进仓库。 */
    static String AUTHX_PREFIX = "";
    static String CLIENT_KEY = "";
    static final String API_BASE = "/music/api/v1";

    private final SharedPreferences sp;
    private final Random rnd = new Random();

    volatile String base = "";
    volatile String token = "";
    volatile String user = "";
    volatile String pass = "";

    FnApi(Context ctx) {
        sp = ctx.getSharedPreferences("fntv", Context.MODE_PRIVATE);
        loadSignKey(ctx);
        base = sp.getString("base", "");
        user = sp.getString("user", "");
        pass = sp.getString("pass", "");
    }

    /** 从 assets/fn_config.json 读签名常量；读不到就留空，登录时会明确报错 */
    private static void loadSignKey(Context ctx) {
        if (AUTHX_PREFIX.length() > 0 && CLIENT_KEY.length() > 0) return;
        try {
            java.io.InputStream in = ctx.getAssets().open("fn_config.json");
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            org.json.JSONObject j = new org.json.JSONObject(bos.toString("UTF-8"));
            AUTHX_PREFIX = j.optString("authxPrefix", "");
            CLIENT_KEY = j.optString("clientKey", "");
        } catch (Exception e) {
            android.util.Log.w("FnApi", "读取 assets/fn_config.json 失败：" + e.getMessage());
        }
        if (AUTHX_PREFIX.length() == 0 || CLIENT_KEY.length() == 0) {
            android.util.Log.w("FnApi", "未配置签名常量，登录会失败。"
                    + "请把 fn_config.example.json 复制成 fn_config.json 并填入 authxPrefix / clientKey。");
        }
    }

    boolean hasSaved() {
        return base.length() > 0 && user.length() > 0 && pass.length() > 0;
    }

    String savedBase() {
        return base;
    }

    String savedUser() {
        return user;
    }

    boolean connected() {
        return token.length() > 0;
    }

    void saveCred(String b, String u, String p, boolean remember) {
        base = b;
        user = u;
        if (remember) {
            pass = p;
            sp.edit().putString("base", b).putString("user", u).putString("pass", p).apply();
        } else {
            pass = p; // 只在内存里留着，用于 token 过期后自动重登
            sp.edit().putString("base", b).putString("user", u).remove("pass").apply();
        }
    }

    void forget() {
        token = "";
        sp.edit().remove("pass").apply();
    }

    // ---------------- 加解密小工具 ----------------

    static String md5(String s) {
        return digest("MD5", s);
    }

    static String sha256hex(String s) {
        return digest("SHA-256", s);
    }

    private static String digest(String alg, String s) {
        try {
            MessageDigest md = MessageDigest.getInstance(alg);
            byte[] d = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                int v = b & 0xff;
                if (v < 16) sb.append('0');
                sb.append(Integer.toHexString(v));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8")
                    .replace("+", "%20")
                    .replace("*", "%2A")
                    .replace("%7E", "~");
        } catch (Exception e) {
            return s;
        }
    }

    /** key 排序 + URLSearchParams 风格编码（与桌面版 canonicalQuery 一致） */
    static String canonicalQuery(Map<String, String> q) {
        if (q == null || q.isEmpty()) return "";
        List<String> keys = new ArrayList<>(q.keySet());
        Collections.sort(keys);
        StringBuilder sb = new StringBuilder();
        for (String k : keys) {
            String v = q.get(k);
            if (v == null) continue;
            if (sb.length() > 0) sb.append('&');
            sb.append(enc(k)).append('=').append(enc(v));
        }
        return sb.toString();
    }

    /** 与桌面版 hashPayload 一致：处理孤立 % 后 decode 再 md5 */
    static String hashPayload(String str) {
        if (str == null) str = "";
        String t = str.replaceAll("%(?![0-9A-Fa-f]{2})", "%25");
        try {
            return md5(URLDecoder.decode(t, "UTF-8"));
        } catch (Exception e) {
            return md5(str);
        }
    }

    String makeAuthx(String method, String pathname, Map<String, String> query, String body) {
        if (AUTHX_PREFIX.length() == 0 || CLIENT_KEY.length() == 0) {
            throw new IllegalStateException(
                    "缺少签名常量：请把 android/assets/fn_config.example.json 复制成 fn_config.json，"
                            + "填入 authxPrefix 与 clientKey 后重新打包");
        }
        boolean isGet = "GET".equalsIgnoreCase(method);
        String nonce = String.valueOf(100000 + rnd.nextInt(900000));
        String ts = String.valueOf(System.currentTimeMillis());
        String payloadHash = isGet ? hashPayload(canonicalQuery(query)) : md5(body == null ? "" : body);
        String src = AUTHX_PREFIX + "_" + pathname + "_" + nonce + "_" + ts + "_" + payloadHash + "_" + CLIENT_KEY;
        return "nonce=" + nonce + "&timestamp=" + ts + "&sign=" + md5(src);
    }

    String deviceId() {
        String v = sp.getString("deviceId", "");
        if (v != null && v.matches("^[a-f0-9]{32}$")) return v;
        StringBuilder sb = new StringBuilder();
        while (sb.length() < 32) sb.append(Integer.toHexString(rnd.nextInt(16)));
        v = sb.toString();
        sp.edit().putString("deviceId", v).apply();
        return v;
    }

    static String normalizeBase(String raw) {
        String b = raw == null ? "" : raw.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        if (b.length() > 0 && !b.matches("(?i)^https?://.*")) b = "http://" + b;
        return b;
    }

    // ---------------- 登录 ----------------

    /** 返回 null 表示成功，否则是错误文案 */
    String login(String b, String u, String p, String accessCode) {
        String pathname = API_BASE + "/user/password-login";
        try {
            JSONObject body = new JSONObject();
            body.put("username", u);
            body.put("password", sha256hex(p));
            body.put("deviceId", deviceId());
            String bodyStr = body.toString();

            HttpURLConnection c = (HttpURLConnection) new URL(b + pathname).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setDoOutput(true);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("Accept-Language", "zh-CN");
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("User-Agent", "fnmusic-tv/1.0");
            c.setRequestProperty("authx", makeAuthx("POST", pathname, null, bodyStr));
            if (accessCode != null && accessCode.length() > 0) {
                c.setRequestProperty("x-access-code", b64(accessCode));
                c.setRequestProperty("x-access-source", "app");
            }
            OutputStream os = c.getOutputStream();
            os.write(bodyStr.getBytes("UTF-8"));
            os.close();

            int code = c.getResponseCode();
            String txt = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
            JSONObject o = new JSONObject(txt);
            if (o.optInt("code", -1) == 0) {
                JSONObject d = o.optJSONObject("data");
                String tk = d == null ? "" : d.optString("userToken", "");
                if (tk.length() > 0) {
                    token = tk;
                    return null;
                }
            }
            String msg = o.optString("msg", "");
            if (msg.length() == 0) msg = "登录失败（HTTP " + code + "）";
            return msg;
        } catch (Exception e) {
            return "连不上 NAS：" + e.getMessage();
        }
    }

    private static String b64(String s) {
        try {
            return android.util.Base64.encodeToString(s.getBytes("UTF-8"), android.util.Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    static String readAll(InputStream in) {
        if (in == null) return "";
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), "UTF-8");
        } catch (Exception e) {
            return "";
        } finally {
            try { in.close(); } catch (Exception e) {}
        }
    }

    static Map<String, String> parseQuery(String raw) {
        Map<String, String> m = new LinkedHashMap<>();
        if (raw == null || raw.length() == 0) return m;
        for (String kv : raw.split("&")) {
            if (kv.length() == 0) continue;
            int i = kv.indexOf('=');
            try {
                if (i < 0) m.put(URLDecoder.decode(kv, "UTF-8"), "");
                else m.put(URLDecoder.decode(kv.substring(0, i), "UTF-8"),
                           URLDecoder.decode(kv.substring(i + 1), "UTF-8"));
            } catch (Exception e) { /* 坏参数直接跳过 */ }
        }
        return m;
    }

    static String buildQuery(Map<String, String> q) {
        StringBuilder sb = new StringBuilder();
        for (Iterator<Map.Entry<String, String>> it = q.entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<String, String> e = it.next();
            if (sb.length() > 0) sb.append('&');
            sb.append(enc(e.getKey())).append('=').append(enc(e.getValue()));
        }
        return sb.toString();
    }
}
