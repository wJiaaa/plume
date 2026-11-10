#!/usr/bin/env bash
#
# 生成 Plume 的 macOS 自签代码签名证书（不需要付费的 Apple 开发者账号）。
#
# 为什么要签：ad-hoc 签名的应用，macOS 按它可执行文件的哈希认人，每次更新都是一个新应用，屏幕录制、辅助功能这些权限
# 全部重置；用证书签（自签的也行），macOS 按证书认人，更新后还是同一个应用，权限留着。见 electron-builder.yml 的 mac.identity。
# 自签证书做不了公证（notarization），那要付费账号；第一次从网上下载安装时 Gatekeeper 仍会拦一下，右键「打开」放行。
#
# 用法：bash apps/desktop/scripts/make-signing-cert.sh [输出目录]，默认 ~/.plume-signing。
# 生成的东西就是签名身份，别进仓库、别弄丢：换一张证书，装过旧证书签的版本的机器上权限会再重置一次。

set -euo pipefail

OUT="${1:-$HOME/.plume-signing}"
NAME="Plume Code Signing"
# 二十年：证书过期以后换新证书，权限又要重置一次，所以给足。
DAYS=7300

if [ -e "$OUT" ]; then
	echo "$OUT 已经存在，不覆盖——先把它挪走" >&2
	echo "（换证书会让旧证书签的版本拿到的权限全部重置）" >&2
	exit 1
fi

mkdir -p "$OUT"
chmod 700 "$OUT"

read -r -s -p "给 .p12 设一个密码：" PASSWORD
echo
if [ -z "$PASSWORD" ]; then
	echo "要设密码：这个文件就是签名身份" >&2
	exit 1
fi

cat > "$OUT/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = $NAME

[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
	-keyout "$OUT/key.pem" -out "$OUT/cert.pem" -config "$OUT/openssl.cnf" 2>/dev/null

# -legacy：macOS 的 security 读不了 OpenSSL 3 默认的加密算法。
openssl pkcs12 -export -legacy \
	-inkey "$OUT/key.pem" -in "$OUT/cert.pem" \
	-out "$OUT/certificate.p12" -passout "pass:$PASSWORD" -name "$NAME" 2>/dev/null

base64 -i "$OUT/certificate.p12" -o "$OUT/certificate.p12.base64"
chmod 600 "$OUT"/*

FINGERPRINT=$(openssl x509 -in "$OUT/cert.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':')

cat <<DONE

好了，都在 $OUT（0600）：
  certificate.p12          签名身份
  certificate.p12.base64   同一个文件的 base64，填 GitHub secret 用
  key.pem / cert.pem       生成它的两部分
  指纹                     $FINGERPRINT

CI 里签：在 GitHub 仓库 Settings › Secrets and variables › Actions 加两个 secret：
  MAC_CERTIFICATE_P12       $OUT/certificate.p12.base64 的内容
  MAC_CERTIFICATE_PASSWORD  刚才输入的密码

本机签：把身份装进自己的钥匙串一次：
  security import $OUT/certificate.p12 -k ~/Library/Keychains/login.keychain-db \\
    -P '<密码>' -T /usr/bin/codesign
  security add-trusted-cert -r trustRoot $OUT/cert.pem
之后 \`pnpm package\` 按名字找到它就用它签（见 apps/desktop/scripts/package.mjs）。

看一个包是不是证书签的：
  codesign -d -r- apps/desktop/release/mac*/Plume.app
  # 要的是：identifier "dev.plume.app" and certificate leaf = H"..."
  # 不是：  cdhash H"..."     <- ad-hoc，每次更新权限都重置
DONE
