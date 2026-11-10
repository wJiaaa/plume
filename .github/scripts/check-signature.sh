#!/usr/bin/env bash
#
# 从打出来的包上读回它的签名身份。
#
# 要抓的失败天生不出声：证书没导进去、身份名字对不上，electron-builder 都会退回 ad-hoc，包照样能装能跑，
# 直到装上以后权限没了才有人发现。指定要求（designated requirement）里出现 `cdhash` 就是 ad-hoc。

set -euo pipefail

APPS=$(find apps/desktop/release -maxdepth 2 -name 'Plume.app')
if [ -z "$APPS" ]; then
	echo "::error::打包输出里没有 Plume.app"
	exit 1
fi

# 每个架构都查：arm64 和 x64 分两遍签，其中一个退回 ad-hoc，只有那一种 Mac 上的权限会重置。
while IFS= read -r APP; do
	REQUIREMENT=$(codesign -d -r- "$APP" 2>&1 | tail -1)
	echo "$APP: $REQUIREMENT"

	case "$REQUIREMENT" in
		*"certificate leaf"*)
			echo "用证书签的：更新后权限留着"
			;;
		*cdhash*)
			if [ "${REQUIRE_SIGNING:-false}" = "true" ] || [ "${HAVE_CERT:-false}" = "true" ]; then
				echo "::error::有证书却是 ad-hoc 签的：导入或身份名字不对，这个包会让权限全部重置"
				exit 1
			fi
			echo "::warning::没有证书，ad-hoc 签，和预期一致"
			;;
		*)
			echo "::error::读不出签名身份，不发一个说不清自己是谁的包"
			exit 1
			;;
	esac
done <<< "$APPS"
