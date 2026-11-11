// color-exempt：选取元素时的框和标签画在网页里（闭合的 shadow root），底下是网页自己的颜色，和 Plume 的主题、皮肤无关，页面里也读不到 Plume 的 token
/**
 * 在网页里跑的那几段脚本：读页面、找元素、等条件、选取元素。都在插件自己的隔离 world 里跑（`isolated`）：
 * 和页面共享 DOM，页面的脚本看不到也改不了它记下的东西，换文档时随旧 world 一起丢掉。
 */

import type { WebPages } from "@plume/contract";

// i18n-exempt：这一页的报错都是给模型的工具结果。

/** 页面卡住时一次求值最多等多久。 */
const UNRESPONSIVE_MS = 15_000;

export async function evaluate(pages: WebPages, id: string, code: string, isolated = true): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pages.evaluate(id, code, { isolated }),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("The page did not respond within 15 seconds")), UNRESPONSIVE_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/*
 * ref 记在隔离 world 的全局上。编号由逻辑入口按页接续，不随文档从 1 重来——否则上一页的 e3 在新页上指向另一个元素，
 * 点下去的是别的东西。
 */
const REFS = "const refs = globalThis.plumeRefs ??= { of: new WeakMap(), at: new Map() };";
const INTERACTIVE =
	"a,button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],[contenteditable=''],[contenteditable=true]";

/** 一次读页面默认交回多少字、最多多少字。读全页的 4 万字放进每次打开、换页的结果里太占上下文，要更多的按 nextOffset 接着读。 */
export const READ_DEFAULT_CHARS = 8000;
export const READ_MAX_CHARS = 40_000;
const MAX_ELEMENTS = 120;

export interface ReadOptions {
	/** 只读这一块（CSS 选择器）：文字和可操作元素都只取它里面的。 */
	selector?: string;
	/** 从正文第几个字开始，接着上一次的 nextOffset 读。不为 0 时不再列元素：它们随第一段给过了。 */
	offset?: number;
	maxChars?: number;
}

export interface PageSnapshot {
	title: string;
	url: string;
	text: string;
	elements?: string[];
	/** 这一块正文的总字数，不是交回的这段。 */
	chars: number;
	truncated?: true;
	nextOffset?: number;
	/** 看得见的可操作元素超过上限、没列出来的个数。 */
	moreElements?: number;
	hint?: string;
}

/** 正文里的空白：行尾空格去掉，连着的空行并成一行，省下的都是 token。 */
const TIDY = "(value) => value.replace(/[ \\t\\u00a0]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()";

/**
 * 页面文字，加上可操作元素各一行：`e7 input:email #mail 邮箱 [value=a@b.c]`。
 *
 * 一行而不是一个对象：120 个元素按对象排版，`"role": null` 这类空字段占了大半。密码框不回显值。
 * 正文默认从 main / article 取，没有时取 body；给了 `selector` 只取那一块，没匹配到时退回整页并在 hint 里说明——猜错一次选择器
 * 不该白花一轮。
 */
export async function snapshotPage(pages: WebPages, id: string, next: number, options: ReadOptions = {}): Promise<PageSnapshot & { next: number }> {
	const spec = {
		selector: options.selector ?? null,
		offset: Math.max(0, Math.floor(options.offset ?? 0)),
		maxChars: Math.max(1, Math.min(Math.floor(options.maxChars ?? READ_DEFAULT_CHARS), READ_MAX_CHARS)),
	};
	const page = (await evaluate(
		pages,
		id,
		`(() => { ${REFS}
		const spec = ${JSON.stringify(spec)}, tidy = ${TIDY};
		let next = ${next};
		const clean = (value, length) => String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, length);
		const kind = (el) => el.getAttribute('role') || (el instanceof HTMLInputElement ? 'input:' + el.type : el.tagName === 'A' ? 'link' : el.isContentEditable && !(el instanceof HTMLTextAreaElement) ? 'editable' : el.tagName.toLowerCase());
		const name = (el) => clean(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) ? el.value : '') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt, 80);
		const line = (el, ref) => {
			const parts = [ref, kind(el)];
			if (el.id && el.id.length <= 40) parts.push('#' + el.id);
			const label = name(el); if (label) parts.push(label);
			if (el instanceof HTMLSelectElement) { if (el.selectedOptions[0]) parts.push('[value=' + clean(el.selectedOptions[0].text, 40) + ']'); }
			else if ((el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'password'].includes(el.type)) || el instanceof HTMLTextAreaElement) { if (el.value) parts.push('[value=' + clean(el.value, 40) + ']'); }
			else if (el instanceof HTMLInputElement && el.type === 'password' && el.value) parts.push('[filled]');
			if (el.checked || el.getAttribute('aria-checked') === 'true') parts.push('[checked]');
			if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') parts.push('[disabled]');
			return parts.join(' ');
		};
		let scope = null, unmatched = false;
		if (spec.selector !== null) {
			try { scope = document.querySelector(spec.selector); } catch { return { error: 'Not a valid CSS selector: ' + spec.selector }; }
			unmatched = !scope;
		}
		const root = scope ?? document.querySelector('main,article,[role=main]') ?? document.body;
		const whole = tidy(root?.innerText ?? '');
		const end = Math.min(whole.length, spec.offset + spec.maxChars);
		const page = { title: document.title, url: location.href, text: whole.slice(spec.offset, end), chars: whole.length };
		if (end < whole.length) { page.truncated = true; page.nextOffset = end; }
		if (spec.offset === 0) {
			const elements = [];
			let more = 0;
			for (const el of (scope ?? document).querySelectorAll(${JSON.stringify(INTERACTIVE)})) {
				if (!el.getClientRects().length) continue;
				if (elements.length >= ${MAX_ELEMENTS}) { more++; continue; }
				let ref = refs.of.get(el);
				if (!ref) { ref = 'e' + next++; refs.of.set(el, ref); refs.at.set(ref, new WeakRef(el)); }
				elements.push(line(el, ref));
			}
			page.elements = elements;
			if (more) page.moreElements = more;
		}
		const hints = [];
		if (unmatched) hints.push('selector ' + JSON.stringify(spec.selector) + ' matched nothing; this is the whole page.');
		if (page.moreElements) hints.push('Only the first ${MAX_ELEMENTS} interactive elements are listed; read with a selector to list the ones in one region.');
		if (page.truncated) hints.push('The text is cut at ' + end + ' of ' + whole.length + ' characters; read with offset ' + end + ' for the rest.');
		if (!whole) hints.push('The page shows no text (an image, a canvas, or still loading); use browser_screenshot to see it.');
		if (hints.length) page.hint = hints.join(' ');
		page.next = next;
		return page;
	})()`,
	)) as (PageSnapshot & { next: number }) | { error: string };
	// 页面里抛的错过不了宿主的求值，只剩一句「脚本没跑完」：错误当结果交回来，在这里抛。
	if ("error" in page) throw new Error(page.error);
	return page;
}

/** 页面此刻的样子：自己的地址、加载到哪、看得见多少字，外加开头一小段（认「加载中…」用）。 */
interface PageState {
	url: string;
	readyState: string;
	length: number;
	head: string;
}

const PROBE = `(() => { const text = (document.body?.innerText ?? '').trim(); return { url: location.href, readyState: document.readyState, length: text.length, head: text.slice(0, 200) }; })()`;

/** 等内容最多多久、多久看一次。 */
const CONTENT_TIMEOUT_MS = 5000;
const CONTENT_POLL_MS = 250;
/**
 * 这么多字的页面直接算有内容；更短的要连着三次（半秒）看到一样长才算停下来：脚本渲染的页先出几百字的页头页脚，正文稍后才到。
 * 这里从 dom-ready 就开始看，比等到 load 早，隔一次（250 毫秒）就放行会把还没到的正文当成没有。
 */
const CONTENT_ENOUGH_CHARS = 1500;
const CONTENT_STEADY_PROBES = 3;
/** 文档还在加载、字又这么少的，多半是正文没到的框架（实测某搜索页先出 114 字的菜单，半秒后才有结果），要连着这么多次不变。 */
const CONTENT_SPARSE_CHARS = 200;
const CONTENT_SPARSE_PROBES = 4;
/** 加载完了还一个字都没有的页（图片、画布、真空白页）等这么久就放行。 */
const CONTENT_BLANK_MS = 2000;
/** 只写着「加载中」「Just a moment」的页：加载状态已完成、内容也不动，和一张很短的正常页分不开，给它这么久变成别的。 */
// i18n-exempt：认网页上的「加载中」字样，不是给人看的文案。
const CONTENT_LOADING_TEXT = /loading|please wait|just a moment|redirecting|加载|載入|请稍|請稍|正在|読み込み|(?:…|\.\.\.)\s*$/i;
const CONTENT_LOADING_MS = 3000;
/** 还没换上要的那张文档时页面自己的地址。 */
const CONTENT_PLACEHOLDER = /^(about|chrome|devtools):/;
/** 换文档的当口问不到页面；连着失败这么多次就不等了。 */
const CONTENT_MAX_FAILURES = 6;

/**
 * 等页面显出内容、字数停下来，再去读它。尽力而为：问不到、到点了都直接返回，由调用方照原样读。
 *
 * 文档能读（dom-ready）时，靠脚本渲染的页往往一个字都还没有，这时读回来的是空页，agent 要再花一轮等、再读一遍。`fresh` 是这一页
 * 刚换了文档（打开、点链接、后退前进刷新）：短页要等字数停下来才算；不是的（读一页早已开着的）有字就放行，只在空着、还在加载时等。
 * 只保证「不是空页」，不保证异步数据全到了；后者仍由 agent 按具体内容 wait。
 */
export async function waitForContent(pages: WebPages, id: string, fresh: boolean): Promise<void> {
	const deadline = Date.now() + CONTENT_TIMEOUT_MS;
	let previous = -1;
	let same = 0;
	let blankSince: number | undefined;
	let loadingSince: number | undefined;
	let failures = 0;
	for (;;) {
		const probedAt = Date.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// 正在卸掉的文档里一次求值可能不回来：每次只等到总时限。
		const state = await Promise.race([
			pages.evaluate(id, PROBE, { isolated: true }) as Promise<PageState>,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), Math.max(deadline - probedAt, CONTENT_POLL_MS));
			}),
		])
			.catch(() => null)
			.finally(() => clearTimeout(timer));
		if (state && typeof state.length === "number") {
			failures = 0;
			const { url, readyState, length } = state;
			const loading = length > 0 && length < CONTENT_SPARSE_CHARS && CONTENT_LOADING_TEXT.test(state.head);
			if (loading && Date.now() - (loadingSince ??= Date.now()) < CONTENT_LOADING_MS) {
				// 还在说「加载中」：接着看。
			} else if (!CONTENT_PLACEHOLDER.test(url) && readyState !== "loading") {
				if (!fresh && length > 0) return;
				if (length >= CONTENT_ENOUGH_CHARS) return;
				same = length === previous ? same + 1 : 1;
				if (length > 0 && same >= (readyState !== "complete" && length < CONTENT_SPARSE_CHARS ? CONTENT_SPARSE_PROBES : CONTENT_STEADY_PROBES)) return;
				if (length === 0 && readyState === "complete") {
					blankSince ??= Date.now();
					if (Date.now() - blankSince >= CONTENT_BLANK_MS) return;
				} else blankSince = undefined;
				previous = length;
			} else {
				// 还不是要的那张文档，或它还在到来：前面看到的都不作数。
				previous = -1;
				same = 0;
				blankSince = undefined;
			}
		} else if (++failures >= CONTENT_MAX_FAILURES) return;
		const rest = CONTENT_POLL_MS - (Date.now() - probedAt);
		if (Date.now() + Math.max(rest, 0) >= deadline) return;
		if (rest > 0) await new Promise<void>((resolve) => setTimeout(resolve, rest));
	}
}

export interface Target {
	ref?: string;
	selector?: string;
}

const SAY = {
	elementMissing: "No such element; read the page again",
	refStale: "{ref} is no longer on this page: it changed or re-rendered; read again for new refs",
	elementHidden: "The element is not visible",
	elementDisabled: "The element is disabled",
	elementMoving: "The element is still moving",
	elementOffscreen: "The element cannot be scrolled into view",
	elementCovered: "The element is covered by {by}",
	gaveUp: "{reason} (waited 3 seconds)",
};

/**
 * 元素中心点，前提是此刻点得到它：在、看得见、没禁用、不在动、落点上没有别的东西挡着。
 *
 * 不满足就等，最多 3 秒——刚渲染出来、动画还没走完、遮罩正在退场，这些都会自己好。还不满足就说出是哪一条，
 * 尤其是被谁挡住：只看找不找得到的话，点在遮罩上照样报成功，agent 要再读一遍才发现什么都没发生。
 * 落点上的元素是它自己、它里面的、或指向它的 label，都算点得到。「不在动」是隔一帧量两次。
 * 没有 ref 也没有 selector 时给视口中心，滚动用。
 */
export async function locate(pages: WebPages, id: string, target: Target, enabled: boolean): Promise<{ x: number; y: number }> {
	const result: unknown = await evaluate(
		pages,
		id,
		`(async () => { ${REFS}
		const ref = ${JSON.stringify(target.ref ?? null)}, selector = ${JSON.stringify(target.selector ?? null)}, say = ${JSON.stringify(SAY)};
		if (ref === null && selector === null) return { x: innerWidth / 2, y: innerHeight / 2 };
		const short = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((name) => '.' + name).join('');
		const find = () => {
			if (ref !== null) {
				const el = refs.at.get(ref)?.deref();
				if (!el?.isConnected) throw new Error(say.refStale.replace('{ref}', ref));
				return el;
			}
			const all = [...document.querySelectorAll(selector)];
			return all.find((el) => el.getClientRects().length) ?? all[0];
		};
		const reaches = (el, hit) => {
			for (let node = hit; node; node = node.parentNode ?? node.host) if (node === el) return true;
			return hit.closest('label')?.control === el;
		};
		const deadline = Date.now() + 3000;
		for (;;) {
			let why;
			const el = find();
			if (!el) why = say.elementMissing;
			else if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') why = say.elementHidden;
			else if (${enabled} && (el.matches(':disabled') || el.closest('[aria-disabled="true"]'))) why = say.elementDisabled;
			else {
				el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
				const before = el.getBoundingClientRect();
				await new Promise((resolve) => setTimeout(resolve, 16));
				const r = el.getBoundingClientRect();
				const left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
				if (r.x !== before.x || r.y !== before.y || r.width !== before.width || r.height !== before.height) why = say.elementMoving;
				else if (right <= left || bottom <= top) why = say.elementOffscreen;
				else {
					const x = (left + right) / 2, y = (top + bottom) / 2;
					let hit = document.elementFromPoint(x, y);
					while (hit?.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
					if (!hit || reaches(el, hit)) return { x, y };
					why = say.elementCovered.replace('{by}', short(hit));
				}
			}
			if (Date.now() >= deadline) throw new Error(say.gaveUp.replace('{reason}', why));
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	})()`,
	);
	if (
		!result ||
		typeof result !== "object" ||
		!("x" in result) ||
		!("y" in result) ||
		typeof result.x !== "number" ||
		typeof result.y !== "number" ||
		!Number.isFinite(result.x) ||
		!Number.isFinite(result.y)
	)
		throw new Error("Could not locate the element");
	return { x: result.x, y: result.y };
}

export interface Condition {
	text?: string;
	selector?: string;
	expression?: string;
	timeout?: number;
}

const pause = (ms: number) => new Promise<false>((resolve) => setTimeout(() => resolve(false), ms));

/**
 * 等页面出现某段文字、某个可见元素，或某个表达式为真。
 *
 * 在逻辑入口里一轮轮问，而不是在页面里等：条件常常要跨一次跳转才成立（提交表单、登录），页面里等的那段脚本跟着旧文档
 * 一起卸掉，再也回不来。每一轮也单独限时，问到正在卸掉的那一页时不至于把整段等待耗在一轮上。
 */
export async function waitPage(pages: WebPages, id: string, condition: Condition, url: () => string): Promise<{ waited: number }> {
	const given = (["text", "selector", "expression"] as const).filter((name) => condition[name] !== undefined);
	if (given.length !== 1) throw new Error("wait needs exactly one of text, selector or expression");
	const timeout = Math.min(Math.max(condition.timeout ?? 10_000, 0), 30_000);
	const probe =
		condition.text !== undefined
			? () => pages.evaluate(id, `(document.body?.innerText ?? '').includes(${JSON.stringify(condition.text)})`, { isolated: true })
			: condition.selector !== undefined
				? () =>
						pages.evaluate(
							id,
							`[...document.querySelectorAll(${JSON.stringify(condition.selector)})].some((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')`,
							{ isolated: true },
						)
				: () => pages.evaluate(id, `Promise.resolve(${condition.expression}).then(Boolean)`);
	const start = Date.now();
	let failure = "";
	for (;;) {
		const left = start + timeout - Date.now();
		const met = await Promise.race([
			probe().then(
				(value) => {
					failure = "";
					return value === true;
				},
				(error: unknown) => {
					failure = error instanceof Error ? error.message : String(error);
					return false;
				},
			),
			pause(Math.min(1_000, Math.max(left, 0))),
		]);
		if (met) return { waited: Date.now() - start };
		if (Date.now() - start >= timeout) {
			const seconds = Math.round(timeout / 1000);
			throw new Error(
				failure
					? `Waited ${seconds} seconds and the condition was not met (the last evaluation failed: ${failure}); the page is at ${url()}`
					: `Waited ${seconds} seconds and the condition was not met; the page is at ${url()}`,
			);
		}
		await pause(Math.min(200, Math.max(start + timeout - Date.now(), 0)));
	}
}

/**
 * 在页面上选一个元素或框一块：画一层不接指针的框和标签，接管指针和 Esc，选好或退出时把监听和画的东西全撤掉。
 * 框和标签的颜色是写死的：它们画在网页上，网页的底色和 Plume 的主题无关。
 */
export function inspectScript(mode: "element" | "region", hint: { region: string; exit: string }): string {
	return `(${INSPECT})(${JSON.stringify(mode)}, ${JSON.stringify(hint)})`;
}

export const CANCEL_INSPECT = "globalThis.__plumeCancelInspect?.()";

const INSPECT = `(mode, hint) => new Promise(resolve => {
	globalThis.__plumeCancelInspect?.();
	const layer=document.createElement('div');
	layer.style.cssText='position:fixed;inset:0;z-index:2147483646;pointer-events:none';
	const root=layer.attachShadow({mode:'closed'});
	const box=document.createElement('div'), label=document.createElement('div');
	box.style.cssText='position:fixed;border:2px solid #339cff;background:#339cff18;box-sizing:border-box;border-radius:3px';
	label.style.cssText='position:fixed;max-width:360px;border-radius:7px;padding:5px 8px;background:#1c2634;color:#fff;font:12px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
	root.append(box,label);document.documentElement.append(layer);
	let start=null, current=null, target=null;
	const paint=(r,text)=>{box.style.left=r.x+'px';box.style.top=r.y+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';label.textContent=text;label.style.left=Math.max(0,Math.min(r.x,innerWidth-360))+'px';label.style.top=Math.max(0,r.y-30)+'px';};
	const selector=(el)=>{if(el.id)return '#'+CSS.escape(el.id);const parts=[];let node=el;while(node&&node!==document.body){let part=node.localName;const siblings=node.parentElement?[...node.parentElement.children].filter(e=>e.localName===node.localName):[];if(siblings.length>1)part+=':nth-of-type('+(siblings.indexOf(node)+1)+')';parts.unshift(part);node=node.parentElement;}return ['body',...parts].join(' > ');};
	const finish=(result)=>{for(const [name,fn] of handlers)document.removeEventListener(name,fn,true);layer.remove();delete globalThis.__plumeCancelInspect;resolve(result);};
	const cancel=()=>finish(null);globalThis.__plumeCancelInspect=cancel;
	const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
	const move=e=>{stop(e);target=document.elementFromPoint(e.clientX,e.clientY);if(!target)return;
		const r=mode==='region'&&start?{x:Math.min(start.x,e.clientX),y:Math.min(start.y,e.clientY),width:Math.abs(start.x-e.clientX),height:Math.abs(start.y-e.clientY)}:target.getBoundingClientRect();
		current={x:r.x,y:r.y,width:r.width,height:r.height};paint(current,(mode==='region'?hint.region:target.localName+(target.id?'#'+target.id:''))+' · '+Math.round(r.width)+' × '+Math.round(r.height)+' · '+hint.exit);};
	const down=e=>{stop(e);start={x:e.clientX,y:e.clientY};};
	const up=e=>{stop(e);if(!target||!current||current.width<2||current.height<2)return;
		const c=getComputedStyle(target),styles={};for(const name of ['display','position','color','background-color','font-family','font-size','line-height','padding','margin','gap','align-items'])styles[name]=c.getPropertyValue(name);
		const r=current;layer.remove();
		finish({url:location.href,title:document.title,selector:selector(target),html:target.outerHTML.slice(0,12000),text:(target.innerText||'').slice(0,6000),styles,bounds:{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.width,innerWidth-Math.max(0,r.x)),height:Math.min(r.height,innerHeight-Math.max(0,r.y))}});
	};
	const key=e=>{stop(e);if(e.key==='Escape')cancel();};
	const handlers=[['pointermove',move],['pointerdown',down],['pointerup',stop],['click',up],['keydown',key]];
	for(const [name,fn] of handlers)document.addEventListener(name,fn,true);
})`;
