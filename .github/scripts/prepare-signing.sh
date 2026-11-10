#!/usr/bin/env bash
#
# 把 macOS 签名身份放到 codesign 找得到的地方。每一行都是某处失败过、
# 而失败时没说清是哪儿错了才加上的。
#
# `REQUIRE_SIGNING` 是正式发版和演练唯一的区别：
#   true   没有证书就失败。给已经装着证书签名版本的人发一个 ad-hoc 的版本，每台机器上的权限都会重置，发出去收不回来。
#   false  没有证书只警告，演练照样把打包跑一遍。
#
# 缺 secret 在这里判断，不在步骤的 `if:` 里：步骤条件里拿不到 `secrets`，写了也不是看上去的意思。

set -euo pipefail

if [ -z "${MAC_CERTIFICATE_P12:-}" ]; then
	if [ "${REQUIRE_SIGNING:-false}" = "true" ]; then
		echo "::error::没有设置 MAC_CERTIFICATE_P12。ad-hoc 签名的版本会让每台装了它的机器上的权限重置，发出去收不回来。在仓库 secrets 里设好 MAC_CERTIFICATE_P12 和 MAC_CERTIFICATE_PASSWORD，见 apps/desktop/scripts/make-signing-cert.sh。"
		exit 1
	fi
	echo "::warning::没有设置 MAC_CERTIFICATE_P12，这次打包只 ad-hoc 签"
	exit 0
fi

KEYCHAIN="$RUNNER_TEMP/plume-signing.keychain"
# 只在这台 runner 上、随它一起扔掉，这个密码不保护任何活得比这次运行长的东西。
KEYCHAIN_PASSWORD=$(openssl rand -base64 24)

echo "$MAC_CERTIFICATE_P12" | base64 --decode > "$RUNNER_TEMP/certificate.p12"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
# 不设的话钥匙串过一会儿自己锁上，打包久一点就什么都签不了。
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import "$RUNNER_TEMP/certificate.p12" -k "$KEYCHAIN" -P "$MAC_CERTIFICATE_PASSWORD" -T /usr/bin/codesign

# 自签证书 find-identity 列得出来，但报 CSSMERR_TP_NOT_TRUSTED，codesign 就说找不到身份：要显式信任它，而信任要单独的证书，不是 .p12。
openssl pkcs12 -legacy -in "$RUNNER_TEMP/certificate.p12" -passin "pass:$MAC_CERTIFICATE_PASSWORD" \
	-clcerts -nokeys -out "$RUNNER_TEMP/certificate.pem"

# 用 sudo 写系统钥匙串，不写用户域：用户域的信任设置要经窗口服务弹授权框，没人点，这一步不失败、一直挂到超时。
sudo security add-trusted-cert -d -r trustRoot \
	-k /Library/Keychains/System.keychain "$RUNNER_TEMP/certificate.pem"

# partition list 里要有 `codesign:`，不然取私钥时等一个没人会点的弹框。
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" > /dev/null

# codesign 只搜用户的钥匙串列表，没告诉过它的钥匙串它不看。
security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')

rm -f "$RUNNER_TEMP/certificate.p12" "$RUNNER_TEMP/certificate.pem"
security find-identity -v -p codesigning "$KEYCHAIN"
