#!/usr/bin/env bash
# 飞牛音乐 TV · 手工打包链路（不需要 Android Studio / Gradle）
#   aapt2 compile/link → javac → d8 → 塞 classes.dex → zipalign → apksigner
#
# ⚠️ aapt2 在 Windows 上打不开含中文的目录（"failed to open directory"），
#    所以先把源码复制到纯英文工作目录 /c/fntvbuild 里编，编完再把 APK 拷回来。
#
# 用法： bash build_apk.sh
set -e

cd "$(dirname "$0")"
PROJ="$PWD"
export JAVA_HOME="$PROJ/tools/jdk-17.0.20.1+1"
export PATH="$JAVA_HOME/bin:$PATH"
SDK="$PROJ/tools/sdk"
BT="$SDK/build-tools/34.0.0"

WORK=/c/fntvbuild
APK_NAME="飞牛音乐TV-1.1.1.apk"
VERSION_CODE=12
VERSION_NAME="1.1.1"

echo "==> 0/7 准备纯英文工作目录 $WORK"
rm -rf "$WORK"
mkdir -p "$WORK/out/gen" "$WORK/out/classes" "$WORK/out/dex"
cp -r "$PROJ/android" "$WORK/android"
cp "$SDK/platforms/android-34/android.jar" "$WORK/android.jar"
AJAR="$WORK/android.jar"
SRC="$WORK/android"
OUT="$WORK/out"

cd "$WORK"

echo "==> 1/7 aapt2 编译资源"
"$BT/aapt2.exe" compile --dir "$SRC/res" -o "$OUT/res.zip" > /dev/null
mkdir -p "$OUT/flat"
python - "$OUT" <<'PY'
import sys, os, zipfile
out = sys.argv[1]
with zipfile.ZipFile(os.path.join(out, 'res.zip')) as z:
    z.extractall(os.path.join(out, 'flat'))
PY

# 注意：不能把 compile 出来的 zip 直接交给 link（它会被当成 overlay 包，
# 报 "resource string/app_name does not override an existing resource"）。
# 正确姿势是把 .flat 一个个作为输入文件传，并加 --auto-add-overlay。
echo "==> 2/7 aapt2 链接（生成 R.java + 基础 APK，带上 assets）"
"$BT/aapt2.exe" link \
  -o "$OUT/base.apk" \
  -I "$AJAR" \
  --auto-add-overlay \
  --manifest "$SRC/AndroidManifest.xml" \
  --java "$OUT/gen" \
  -A "$SRC/assets" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code $VERSION_CODE \
  --version-name $VERSION_NAME \
  "$OUT"/flat/*.flat

echo "==> 3/7 javac 编译 Java 源码"
javac -encoding UTF-8 -source 8 -target 8 -nowarn \
  -bootclasspath "$AJAR" \
  -d "$OUT/classes" \
  "$SRC"/java/com/junze/fntv/*.java \
  "$OUT"/gen/com/junze/fntv/R.java

echo "==> 4/7 d8 转 dex"
jar cf "$OUT/classes.jar" -C "$OUT/classes" .
"$BT/d8.bat" --lib "$AJAR" --min-api 21 --output "$OUT/dex" "$OUT/classes.jar" > /dev/null

echo "==> 5/7 合成 APK + zipalign"
python - "$OUT" <<'PY'
import sys, os, zipfile, shutil
out = sys.argv[1]
shutil.copyfile(os.path.join(out, 'base.apk'), os.path.join(out, 'app-raw.apk'))
with zipfile.ZipFile(os.path.join(out, 'app-raw.apk'), 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(os.path.join(out, 'dex', 'classes.dex'), 'classes.dex')
print('   classes.dex 已写入')
PY

echo "==> 6/7 对齐 + 签名"
"$BT/zipalign.exe" -f -p 4 "$OUT/app-raw.apk" "$OUT/app-aligned.apk"

KS="$PROJ/fnmusic-tv.keystore"
# 签名密码走环境变量，不写进仓库：export KS_PASS=你的密码
if [ -z "$KS_PASS" ]; then
  echo "!! 缺少签名密码。请先执行： export KS_PASS=你的签名密码" >&2
  echo "   （这个密码要和 fnmusic-tv.keystore 对应，忘了就再也签不出一致的升级包）" >&2
  exit 1
fi
if [ ! -f "$KS" ]; then
  echo "   首次打包：生成签名证书（以后升级必须用同一个）"
  keytool -genkeypair -keystore "$KS" -alias fntv -keyalg RSA -keysize 2048 \
    -validity 12000 -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=junze, OU=dev, O=junze, L=Shenyang, ST=Liaoning, C=CN" > /dev/null 2>&1
fi

"$BT/apksigner.bat" sign \
  --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$WORK/$APK_NAME" "$OUT/app-aligned.apk"

echo "==> 7/7 校验"
"$BT/apksigner.bat" verify --print-certs "$WORK/$APK_NAME" | head -4
cp "$WORK/$APK_NAME" "$PROJ/$APK_NAME"
ls -lh "$PROJ/$APK_NAME"
echo "==> 完成：$PROJ/$APK_NAME"
