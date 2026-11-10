/** 环境变量和请求头的规矩，两个入口共用（这里不能引用 Node 的模块）。 */

const SECRET_WORDS = new Set([
	"KEY",
	"TOKEN",
	"SECRET",
	"PASSWORD",
	"PASS",
	"PASSWD",
	"PAT",
	"AUTH",
	"AUTHORIZATION",
	"CREDENTIAL",
	"CREDENTIALS",
	"COOKIE",
	"DSN",
]);
const DATABASE_WORDS = new Set(["DATABASE", "DB", "POSTGRES", "POSTGRESQL", "PG", "MYSQL", "MONGO", "MONGODB", "REDIS", "CONNECTION"]);

/**
 * 名字像不像机密：密钥、令牌、密码、数据库连接串。按 `_`、`-` 切成词再认，不按子串：子串会把 `PATH` 认成 `PAT`、
 * 把 `API_BASE_URL` 认成连接串。拿不准时宁可当机密：多藏一个值只是界面上看不到，少藏一个就进了渲染进程。
 */
export function looksSecret(name: string): boolean {
	const words = name
		.toUpperCase()
		.split(/[^A-Z0-9]+/)
		.filter(Boolean);
	// 词尾也算：`APIKEY`、`PGPASSWORD`、`BOTTOKEN` 是连写的同一个意思。
	if (words.some((word) => SECRET_WORDS.has(word) || /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/.test(word))) return true;
	return words.some((word) => DATABASE_WORDS.has(word)) && words.some((word) => word === "URL" || word === "URI" || word === "STRING");
}

/** 环境变量名、请求头名。 */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
