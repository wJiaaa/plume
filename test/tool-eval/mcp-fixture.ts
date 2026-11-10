/**
 * 评测用的 30 台假 MCP 服务器、每台十个上下的工具，schema 照真实服务器的写法：GitHub、Linear、Notion、Slack、
 * Sentry 五台按它们官方 MCP 服务器的工具名、参数名和描述口吻写，其余 25 台按同样的口吻按资源生成。
 * 再加一台 Twilio：mcp-cache-eval 在会话中途才连上它。
 *
 * 只是数据。真的连上它们靠 `mcp-fixture-server.ts`：一台 stdio MCP 服务器按 id 报出其中一台的工具、把调用记下来，
 * 经 plume.mcp 的配置接进来，延迟加载、搜索、调用都走插件自己的那一套。
 */

interface FixtureTool {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface FixtureServer {
	id: string;
	name: string;
	description: string;
	tools: FixtureTool[];
}

type Param = [type: string, description: string, extra?: Record<string, unknown>];

function tool(
	name: string,
	description: string,
	params: Record<string, Param>,
	required: string[] = [],
	annotations?: FixtureTool["annotations"],
): FixtureTool {
	const properties: Record<string, unknown> = {};
	for (const [key, [type, text, extra]] of Object.entries(params)) {
		properties[key] = type === "string[]" ? { type: "array", items: { type: "string" }, description: text, ...extra } : { type, description: text, ...extra };
	}
	return {
		name,
		description,
		inputSchema: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
		...(annotations ? { annotations } : {}),
	};
}

const READ = { readOnlyHint: true };
const PAGE: Record<string, Param> = {
	perPage: ["number", "Results per page for pagination (min 1, max 100)", { minimum: 1, maximum: 100 }],
	page: ["number", "Page number for pagination (min 1)", { minimum: 1 }],
};
const REPO: Record<string, Param> = {
	owner: ["string", "Repository owner (username or organization)"],
	repo: ["string", "Repository name"],
};

const github: FixtureServer = {
	id: "github",
	name: "GitHub",
	description: "Repositories, issues, pull requests, code search and file contents on GitHub.",
	tools: [
		tool(
			"create_issue",
			"Create a new issue in a GitHub repository.",
			{
				...REPO,
				title: ["string", "Issue title"],
				body: ["string", "Issue body content"],
				assignees: ["string[]", "Usernames to assign to this issue"],
				labels: ["string[]", "Labels to apply to this issue"],
				milestone: ["number", "Milestone number"],
			},
			["owner", "repo", "title"],
		),
		tool(
			"get_issue",
			"Get details of a specific issue in a GitHub repository.",
			{ ...REPO, issue_number: ["number", "The number of the issue"] },
			["owner", "repo", "issue_number"],
			READ,
		),
		tool(
			"list_issues",
			"List issues in a GitHub repository. For pagination, use the 'endCursor' from the previous response's 'pageInfo' in the 'after' parameter.",
			{
				...REPO,
				state: ["string", "Filter by state, by default both open and closed issues are returned when not provided", { enum: ["OPEN", "CLOSED"] }],
				labels: ["string[]", "Filter by labels"],
				orderBy: [
					"string",
					"Order issues by field. If provided, the 'direction' also needs to be provided.",
					{ enum: ["CREATED_AT", "UPDATED_AT", "COMMENTS"] },
				],
				direction: ["string", "Order direction. If provided, the 'orderBy' also needs to be provided.", { enum: ["ASC", "DESC"] }],
				since: ["string", "Filter by date (ISO 8601 timestamp)"],
				after: ["string", "Cursor for pagination. Use the endCursor from the previous page's PageInfo for GraphQL APIs."],
				...PAGE,
			},
			["owner", "repo"],
			READ,
		),
		tool(
			"update_issue",
			"Update an existing issue in a GitHub repository.",
			{
				...REPO,
				issue_number: ["number", "Issue number to update"],
				title: ["string", "New title"],
				body: ["string", "New description"],
				state: ["string", "New state", { enum: ["open", "closed"] }],
				state_reason: ["string", "Reason for the state change. Ignored unless state is changed.", { enum: ["completed", "not_planned", "duplicate"] }],
				labels: ["string[]", "New labels"],
				assignees: ["string[]", "New assignees"],
				milestone: ["number", "New milestone number"],
			},
			["owner", "repo", "issue_number"],
		),
		tool(
			"add_issue_comment",
			"Add a comment to a specific issue in a GitHub repository. Use this tool to add comments to pull requests as well (in this case pass pull request number as issue_number), but only if user is not asking specifically to add review comments.",
			{ ...REPO, issue_number: ["number", "Issue number to comment on"], body: ["string", "Comment content"] },
			["owner", "repo", "issue_number", "body"],
		),
		tool(
			"search_code",
			"Fast and precise code search across ALL GitHub repositories using GitHub's native search engine. Best for finding exact symbols, functions, classes, or specific code patterns.",
			{
				query: [
					"string",
					"Search query using GitHub's powerful code search syntax. Examples: 'content:Skill language:Java org:github', 'NOT is:archived language:Python OR language:go', 'repo:github/github-mcp-server'. Supports exact matching, language filters, path filters, and more.",
				],
				sort: ["string", "Sort field ('indexed' only)"],
				order: ["string", "Sort order for results", { enum: ["asc", "desc"] }],
				...PAGE,
			},
			["query"],
			READ,
		),
		tool(
			"get_file_contents",
			"Get the contents of a file or directory from a GitHub repository",
			{
				...REPO,
				path: ["string", "Path to file/directory (directories must end with a slash '/')"],
				ref: ["string", "Accepts optional git refs such as `refs/tags/{tag}`, `refs/heads/{branch}` or `refs/pull/{pr_number}/head`"],
				sha: ["string", "Accepts optional commit SHA. If specified, it will be used instead of ref"],
			},
			["owner", "repo"],
			READ,
		),
		tool(
			"create_pull_request",
			"Create a new pull request in a GitHub repository.",
			{
				...REPO,
				title: ["string", "PR title"],
				body: ["string", "PR description"],
				head: ["string", "Branch containing changes"],
				base: ["string", "Branch to merge into"],
				draft: ["boolean", "Create as draft PR"],
				maintainer_can_modify: ["boolean", "Allow maintainer edits"],
			},
			["owner", "repo", "title", "head", "base"],
		),
		tool(
			"list_pull_requests",
			"List pull requests in a GitHub repository. If the user specifies an author, then DO NOT use this tool and use the search_pull_requests tool instead.",
			{
				...REPO,
				state: ["string", "Filter by state", { enum: ["open", "closed", "all"] }],
				head: ["string", "Filter by head user/org and branch"],
				base: ["string", "Filter by base branch"],
				sort: ["string", "Sort by", { enum: ["created", "updated", "popularity", "long-running"] }],
				direction: ["string", "Sort direction", { enum: ["asc", "desc"] }],
				...PAGE,
			},
			["owner", "repo"],
			READ,
		),
		tool(
			"merge_pull_request",
			"Merge a pull request in a GitHub repository.",
			{
				...REPO,
				pullNumber: ["number", "Pull request number"],
				commit_title: ["string", "Title for merge commit"],
				commit_message: ["string", "Extra detail for merge commit"],
				merge_method: ["string", "Merge method", { enum: ["merge", "squash", "rebase"] }],
			},
			["owner", "repo", "pullNumber"],
			{ destructiveHint: true },
		),
		tool(
			"create_branch",
			"Create a new branch in a GitHub repository",
			{ ...REPO, branch: ["string", "Name for new branch"], from_branch: ["string", "Source branch (defaults to repo default)"] },
			["owner", "repo", "branch"],
		),
		tool(
			"list_commits",
			"Get list of commits of a branch in a GitHub repository. Returns at least 30 results per page by default, but can return more if specified using the perPage parameter (up to 100).",
			{
				...REPO,
				sha: [
					"string",
					"Commit SHA, branch or tag name to list commits of. If not provided, uses the default branch of the repository. If a commit SHA is provided, will list commits up to that SHA.",
				],
				author: ["string", "Author username or email address to filter commits by"],
				...PAGE,
			},
			["owner", "repo"],
			READ,
		),
	],
};

const linear: FixtureServer = {
	id: "linear",
	name: "Linear",
	description: "Issues, projects, cycles and teams in Linear.",
	tools: [
		tool(
			"list_issues",
			"List issues in the user's Linear workspace",
			{
				query: ["string", "An optional search query"],
				team: ["string", "The team name or ID"],
				state: ["string", "The state name or ID"],
				assignee: ["string", "The assignee. Can be a user ID or name, or 'me'"],
				label: ["string", "The label name or ID"],
				project: ["string", "The project name or ID"],
				createdAt: ["string", "Return only issues created on or after this ISO-8601 date-time or duration (e.g. -P1D)"],
				updatedAt: ["string", "Return only issues updated on or after this ISO-8601 date-time or duration"],
				orderBy: ["string", "Order by", { enum: ["createdAt", "updatedAt"], default: "updatedAt" }],
				limit: ["number", "The number of results to return (max 250)", { default: 50 }],
				includeArchived: ["boolean", "Whether to include archived issues", { default: true }],
			},
			[],
			READ,
		),
		tool(
			"get_issue",
			"Retrieve detailed information about an issue by ID, including attachments and git branch name",
			{ id: ["string", "The issue ID"] },
			["id"],
			READ,
		),
		tool(
			"create_issue",
			"Create a new Linear issue",
			{
				title: ["string", "The issue title"],
				team: ["string", "The team name or ID"],
				description: ["string", "The issue description as Markdown"],
				cycle: ["string", "The cycle name, number, or ID"],
				priority: ["number", "The issue priority. 0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low."],
				project: ["string", "The project name or ID"],
				state: ["string", "The issue state type, name, or ID"],
				assignee: ["string", "The assignee. Can be a user ID or name, or 'me'"],
				labels: ["string[]", "Array of label names or IDs"],
				dueDate: ["string", "The due date for the issue in ISO format"],
				parentId: ["string", "The parent issue ID, if this is a sub-issue"],
			},
			["title", "team"],
		),
		tool(
			"update_issue",
			"Update an existing Linear issue",
			{
				id: ["string", "The issue ID"],
				title: ["string", "The issue title"],
				description: ["string", "The issue description as Markdown"],
				priority: ["number", "The issue priority. 0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low."],
				state: ["string", "The issue state type, name, or ID"],
				assignee: ["string", "The assignee. Can be a user ID or name, or 'me'"],
				labels: ["string[]", "Array of label names or IDs"],
				estimate: ["number", "The numerical issue estimate value"],
				dueDate: ["string", "The due date for the issue in ISO format"],
			},
			["id"],
		),
		tool("list_comments", "List comments for a specific Linear issue", { issueId: ["string", "The issue ID"] }, ["issueId"], READ),
		tool(
			"create_comment",
			"Create a comment on a specific Linear issue",
			{
				issueId: ["string", "The issue ID"],
				body: ["string", "The content of the comment as Markdown"],
				parentId: ["string", "A parent comment ID to reply to"],
			},
			["issueId", "body"],
		),
		tool(
			"list_projects",
			"List projects in the user's Linear workspace",
			{
				team: ["string", "The team name or ID"],
				state: ["string", "The state name or ID"],
				member: ["string", "User ID, name, or 'me' to filter by membership"],
				includeArchived: ["boolean", "Whether to include archived projects"],
				limit: ["number", "The number of results to return (max 250)"],
			},
			[],
			READ,
		),
		tool(
			"list_teams",
			"List teams in the user's Linear workspace",
			{ query: ["string", "An optional search query"], includeArchived: ["boolean", "Whether to include archived teams"] },
			[],
			READ,
		),
		tool(
			"list_cycles",
			"Retrieve cycles for a specific Linear team",
			{ teamId: ["string", "The team ID"], type: ["string", "Retrieve current, previous, next, or all cycles", { enum: ["current", "previous", "next"] }] },
			["teamId"],
			READ,
		),
		tool(
			"list_issue_labels",
			"List available issue labels in a Linear workspace or team",
			{ team: ["string", "The team name or ID"], name: ["string", "Filter by label name"] },
			[],
			READ,
		),
	],
};

const notion: FixtureServer = {
	id: "notion",
	name: "Notion",
	description: "Search, read and edit pages and databases in a Notion workspace.",
	tools: [
		tool(
			"notion-search",
			'Perform a search over: - "internal": Semantic search over Notion workspace and connected sources (Slack, Google Drive, Github, Jira, Microsoft Teams, Sharepoint, OneDrive, or Linear). - "user": Search for users by name or email. Use the fetch tool for full contents after finding a page.',
			{
				query: [
					"string",
					"Semantic search query over your entire Notion workspace and connected sources. For best results, don't provide more than one question per tool call.",
				],
				query_type: ["string", "The type of search", { enum: ["internal", "user"] }],
				data_source_url: [
					"string",
					"Optionally, provide the URL of a Data source to search. This will perform a semantic search over the pages in the Data Source.",
				],
				page_url: [
					"string",
					"Optionally, provide the URL or ID of a page to search within. This will perform a semantic search over the content within and under the specified page.",
				],
			},
			["query"],
			READ,
		),
		tool(
			"notion-fetch",
			'Retrieves details about a Notion entity by its URL or ID. You can fetch the following types of entities: Page, i.e. from a <page> block or a <mention-page> mention; Database, i.e. from a <database> block or a <mention-database> mention. Use the "fetch" tool when you need to see the details of a Notion entity you already know exists and have its URL or ID.',
			{ id: ["string", "The ID or URL of the Notion page to fetch"] },
			["id"],
			READ,
		),
		tool(
			"notion-create-pages",
			"Creates one or more Notion pages with specified properties and content. All pages created with a single call to this tool will have the same parent. The parent can be a Notion page or data source. If the parent is omitted, the pages will be created as standalone, workspace-level private pages. Content must use Notion-flavored Markdown.",
			{
				parent: ["object", "The parent under which the new pages will be created. Either { page_id } or { data_source_id }."],
				pages: [
					"array",
					"The pages to create. Each has optional properties (title and data-source properties) and content in Notion-flavored Markdown.",
					{ items: { type: "object", properties: { properties: { type: "object" }, content: { type: "string" } } } },
				],
			},
			["pages"],
		),
		tool(
			"notion-update-page",
			"Update a Notion page's properties or content. Use command replace_content to replace the entire content, insert_content_after to insert after a selection, replace_content_range to replace a selection, or update_properties to change properties.",
			{
				page_id: ["string", "The ID of the page to update, with or without dashes."],
				command: ["string", "The update command", { enum: ["update_properties", "replace_content", "replace_content_range", "insert_content_after"] }],
				properties: ["object", "Properties to update, for update_properties"],
				new_str: ["string", "The new content string, for content commands"],
				selection_with_ellipsis: [
					"string",
					'Unique start and end snippet of the string to replace in the page content, e.g. "# Section heading...last paragraph."',
				],
			},
			["page_id", "command"],
		),
		tool(
			"notion-move-pages",
			"Move one or more Notion pages or databases to a new parent.",
			{
				page_or_database_ids: ["string[]", "An array of up to 100 page or database IDs to move."],
				new_parent: ["object", 'The new parent: { page_id } | { database_id } | { data_source_id } | { type: "workspace" }'],
			},
			["page_or_database_ids", "new_parent"],
		),
		tool(
			"notion-duplicate-page",
			"Duplicate a Notion page. The page must be within the current workspace, and you must have permission to access it. The duplication completes asynchronously.",
			{ page_id: ["string", "The ID of the page to duplicate."] },
			["page_id"],
		),
		tool(
			"notion-create-database",
			'Creates a new Notion database with the specified properties schema. If no title property is provided, "Name" is automatically added.',
			{
				parent: [
					"object",
					"The parent under which to create the new database. If omitted, the database will be created as a private page at the workspace level.",
				],
				title: ["string", "The title of the new database"],
				description: ["string", "The description of the new database"],
				properties: ["object", "The property schema of the new database. Keys are property names; values describe the property type and its configuration."],
			},
			["properties"],
		),
		tool(
			"notion-create-comment",
			"Add a comment to a page",
			{
				parent: ["object", "The parent of the comment. This must be a page: { page_id }."],
				rich_text: ["array", "An array of rich text objects that represent the content of the comment.", { items: { type: "object" } }],
			},
			["parent", "rich_text"],
		),
		tool("notion-get-comments", "Get all comments of a page", { page_id: ["string", "Identifier for a Notion page."] }, ["page_id"], READ),
		tool(
			"notion-get-users",
			"Lists all users in the workspace.",
			{
				query: ["string", "Search text to filter users by name or email"],
				start_cursor: ["string", "Cursor for pagination"],
				page_size: ["number", "Number of users to return (max 100)"],
			},
			[],
			READ,
		),
	],
};

const slack: FixtureServer = {
	id: "slack",
	name: "Slack",
	description: "Channels, messages, threads and users in a Slack workspace.",
	tools: [
		tool(
			"slack_list_channels",
			"List public or pre-defined channels in the workspace with pagination",
			{
				limit: ["number", "Maximum number of channels to return (default 100, max 200)", { default: 100 }],
				cursor: ["string", "Pagination cursor for next page of results"],
			},
			[],
			READ,
		),
		tool(
			"slack_post_message",
			"Post a new message to a Slack channel",
			{ channel_id: ["string", "The ID of the channel to post to"], text: ["string", "The message text to post"] },
			["channel_id", "text"],
		),
		tool(
			"slack_reply_to_thread",
			"Reply to a specific message thread in Slack",
			{
				channel_id: ["string", "The ID of the channel containing the thread"],
				thread_ts: [
					"string",
					"The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it.",
				],
				text: ["string", "The reply text"],
			},
			["channel_id", "thread_ts", "text"],
		),
		tool(
			"slack_add_reaction",
			"Add a reaction emoji to a message",
			{
				channel_id: ["string", "The ID of the channel containing the message"],
				timestamp: ["string", "The timestamp of the message to react to"],
				reaction: ["string", "The name of the emoji reaction (without ::)"],
			},
			["channel_id", "timestamp", "reaction"],
		),
		tool(
			"slack_get_channel_history",
			"Get recent messages from a channel",
			{ channel_id: ["string", "The ID of the channel"], limit: ["number", "Number of messages to retrieve (default 10)", { default: 10 }] },
			["channel_id"],
			READ,
		),
		tool(
			"slack_get_thread_replies",
			"Get all replies in a message thread",
			{
				channel_id: ["string", "The ID of the channel containing the thread"],
				thread_ts: ["string", "The timestamp of the parent message in the format '1234567890.123456'."],
			},
			["channel_id", "thread_ts"],
			READ,
		),
		tool(
			"slack_get_users",
			"Get a list of all users in the workspace with their basic profile information",
			{
				cursor: ["string", "Pagination cursor for next page of results"],
				limit: ["number", "Maximum number of users to return (default 100, max 200)", { default: 100 }],
			},
			[],
			READ,
		),
		tool("slack_get_user_profile", "Get detailed profile information for a specific user", { user_id: ["string", "The ID of the user"] }, ["user_id"], READ),
		tool(
			"slack_search_messages",
			"Search messages across the workspace with Slack's search modifiers (in:#channel, from:@user, before:, after:, has:link).",
			{
				query: ["string", "Search query, Slack search syntax"],
				sort: ["string", "Sort by", { enum: ["score", "timestamp"] }],
				count: ["number", "Results per page (max 100)"],
			},
			["query"],
			READ,
		),
	],
};

const sentry: FixtureServer = {
	id: "sentry",
	name: "Sentry",
	description: "Errors, issues, events, releases and performance data from Sentry.",
	tools: [
		tool(
			"find_organizations",
			"Find organizations that the user has access to in Sentry. Use this tool when you need to: View all organizations in Sentry; Find an organization's slug to aid other tool requests",
			{},
			[],
			READ,
		),
		tool(
			"find_projects",
			"Find projects in Sentry.",
			{
				organizationSlug: [
					"string",
					"The organization's slug. You can find a existing list of organizations you have access to using the `find_organizations()` tool.",
				],
				regionUrl: ["string", "The region URL for the organization you're querying, if known."],
			},
			["organizationSlug"],
			READ,
		),
		tool(
			"search_issues",
			"Search for grouped issues/problems in Sentry - returns a LIST of issues, NOT counts or aggregations. Uses AI to translate natural language queries into Sentry issue search syntax.",
			{
				organizationSlug: ["string", "The organization's slug."],
				naturalLanguageQuery: ["string", "Natural language description of issues to search for"],
				projectSlugOrId: ["string", "The project's slug or numeric ID (optional)"],
				limit: ["number", "Maximum number of issues to return", { default: 10 }],
			},
			["organizationSlug", "naturalLanguageQuery"],
			READ,
		),
		tool(
			"get_issue_details",
			"Get detailed information about a specific Sentry issue by ID. Use this tool when you need to: Investigate a specific production error; Access detailed issue information and stacktraces from Sentry.",
			{
				organizationSlug: ["string", "The organization's slug."],
				issueId: ["string", "The Issue ID. e.g. `PROJECT-1Z43`"],
				issueUrl: ["string", "The URL of the issue. e.g. https://my-organization.sentry.io/issues/PROJECT-1Z43"],
				eventId: ["string", "The ID of the event."],
			},
			[],
			READ,
		),
		tool(
			"update_issue",
			"Update an issue's status or assignment in Sentry. This allows you to resolve, ignore, or reassign issues.",
			{
				organizationSlug: ["string", "The organization's slug."],
				issueId: ["string", "The Issue ID. e.g. `PROJECT-1Z43`"],
				status: ["string", "The new status for the issue", { enum: ["resolved", "resolvedInNextRelease", "unresolved", "ignored"] }],
				assignedTo: ["string", "The assignee in format 'user:ID' or 'team:ID'"],
			},
			["organizationSlug", "issueId"],
		),
		tool(
			"search_events",
			"Search for events AND perform counts/aggregations - the ONLY tool for statistics and counts. Supports errors, logs and spans datasets.",
			{
				organizationSlug: ["string", "The organization's slug."],
				naturalLanguageQuery: ["string", "Natural language description of what you want to search for"],
				dataset: ["string", "Dataset to query", { enum: ["errors", "logs", "spans"] }],
				projectSlug: ["string", "Filter by project slug"],
				limit: ["number", "Maximum number of results to return", { default: 10 }],
			},
			["organizationSlug", "naturalLanguageQuery"],
			READ,
		),
		tool(
			"find_releases",
			"Find releases in Sentry. Use this tool when you need to: Find recent releases in a Sentry organization; Find the most recent version released of a specific project; Determine when a release was deployed to an environment.",
			{
				organizationSlug: ["string", "The organization's slug."],
				projectSlug: ["string", "The project's slug."],
				query: ["string", "Search for versions which contain the provided string."],
			},
			["organizationSlug"],
			READ,
		),
		tool(
			"get_trace_details",
			"Get high-level overview of a Sentry trace by ID: statistics such as span counts and the most frequent operations.",
			{ organizationSlug: ["string", "The organization's slug."], traceId: ["string", "The trace ID. e.g. `a4d1aae7216b47ff8117cf4e09ce9d0a`"] },
			["organizationSlug", "traceId"],
			READ,
		),
	],
};

/**
 * 其余 25 台：每台几种资源，每种资源 list / get / create / update / delete 里挑几个。参数取各家 API
 * 真实存在的字段，描述照真实服务器的口吻；只是不再逐个手写。
 */
interface Resource {
	noun: string;
	plural?: string;
	scope: Record<string, Param>;
	fields: Record<string, Param>;
	ops: ("list" | "get" | "create" | "update" | "delete" | "search")[];
	required?: string[];
}

function generated(id: string, name: string, description: string, resources: Resource[]): FixtureServer {
	const tools: FixtureTool[] = [];
	for (const r of resources) {
		const plural = r.plural ?? `${r.noun}s`;
		const scopeKeys = Object.keys(r.scope);
		const idKey = `${r.noun.replace(/ /g, "_")}_id`;
		const key = r.noun.replace(/ /g, "_");
		const pluralKey = plural.replace(/ /g, "_");
		for (const op of r.ops) {
			if (op === "list")
				tools.push(
					tool(
						`list_${pluralKey}`,
						`List ${plural} in ${name}. Results are paginated; pass the cursor from the previous response to get the next page.`,
						{
							...r.scope,
							limit: ["number", "Maximum number of results to return (default 25, max 100)"],
							cursor: ["string", "Pagination cursor from a previous response"],
						},
						scopeKeys,
						READ,
					),
				);
			if (op === "search")
				tools.push(
					tool(
						`search_${pluralKey}`,
						`Search ${plural} in ${name} by keyword and filters. Returns the best matches first.`,
						{
							...r.scope,
							query: ["string", `Free-text query matched against ${r.noun} names and content`],
							filters: ["object", 'Field filters, e.g. { "status": "open" }'],
							limit: ["number", "Maximum number of results (max 100)"],
						},
						[...scopeKeys, "query"],
						READ,
					),
				);
			if (op === "get")
				tools.push(
					tool(
						`get_${key}`,
						`Get a single ${r.noun} in ${name} by ID, with all of its fields.`,
						{ ...r.scope, [idKey]: ["string", `The ${r.noun} ID`] },
						[...scopeKeys, idKey],
						READ,
					),
				);
			if (op === "create")
				tools.push(tool(`create_${key}`, `Create a new ${r.noun} in ${name}.`, { ...r.scope, ...r.fields }, [...scopeKeys, ...(r.required ?? [])]));
			if (op === "update")
				tools.push(
					tool(
						`update_${key}`,
						`Update fields of an existing ${r.noun} in ${name}. Only the fields you pass are changed.`,
						{ ...r.scope, [idKey]: ["string", `The ${r.noun} ID`], ...r.fields },
						[...scopeKeys, idKey],
					),
				);
			if (op === "delete")
				tools.push(
					tool(
						`delete_${key}`,
						`Permanently delete a ${r.noun} in ${name}. This cannot be undone.`,
						{ ...r.scope, [idKey]: ["string", `The ${r.noun} ID`] },
						[...scopeKeys, idKey],
						{ destructiveHint: true },
					),
				);
		}
	}
	return { id, name, description, tools };
}

const P = (description: string): Param => ["string", description];

const rest: FixtureServer[] = [
	generated("gitlab", "GitLab", "Projects, merge requests, issues and pipelines on GitLab.", [
		{
			noun: "merge request",
			scope: { project_id: P("Project ID or URL-encoded path") },
			fields: {
				title: P("Merge request title"),
				source_branch: P("Branch with the changes"),
				target_branch: P("Branch to merge into"),
				description: P("Description in Markdown"),
			},
			ops: ["list", "get", "create", "update"],
			required: ["title", "source_branch", "target_branch"],
		},
		{
			noun: "pipeline",
			scope: { project_id: P("Project ID or URL-encoded path") },
			fields: { ref: P("Branch or tag to run the pipeline for"), variables: ["object", "Pipeline variables as key/value pairs"] },
			ops: ["list", "get", "create"],
			required: ["ref"],
		},
		{
			noun: "issue",
			scope: { project_id: P("Project ID or URL-encoded path") },
			fields: { title: P("Issue title"), description: P("Issue description"), labels: ["string[]", "Label names"] },
			ops: ["list", "create"],
			required: ["title"],
		},
	]),
	generated("jira", "Jira", "Jira issues, sprints, boards and JQL search.", [
		{
			noun: "issue",
			scope: {},
			fields: {
				project_key: P("Project key, e.g. ENG"),
				summary: P("Issue summary"),
				issue_type: P("Issue type name, e.g. Bug, Task, Story"),
				description: P("Description in Atlassian Document Format or plain text"),
				priority: P("Priority name"),
				assignee_account_id: P("Atlassian account ID of the assignee"),
			},
			ops: ["search", "get", "create", "update"],
			required: ["project_key", "summary", "issue_type"],
		},
		{
			noun: "sprint",
			scope: { board_id: ["number", "Board ID"] },
			fields: { name: P("Sprint name"), goal: P("Sprint goal"), start_date: P("ISO 8601 start"), end_date: P("ISO 8601 end") },
			ops: ["list", "create"],
			required: ["name"],
		},
		{
			noun: "transition",
			scope: { issue_key: P("Issue key, e.g. ENG-123") },
			fields: { transition_id: P("Transition ID from list_transitions"), comment: P("Comment to add with the transition") },
			ops: ["list", "create"],
			required: ["transition_id"],
		},
	]),
	generated("confluence", "Confluence", "Confluence spaces, pages and CQL search.", [
		{
			noun: "page",
			scope: { space_key: P("Space key") },
			fields: { title: P("Page title"), body: P("Page body in storage format"), parent_id: P("Parent page ID") },
			ops: ["search", "get", "create", "update"],
			required: ["title", "body"],
		},
		{ noun: "space", scope: {}, fields: { key: P("Space key"), name: P("Space name") }, ops: ["list", "get"] },
		{ noun: "comment", scope: { page_id: P("Page ID") }, fields: { body: P("Comment body") }, ops: ["list", "create"], required: ["body"] },
	]),
	generated("discord", "Discord", "Discord servers, channels and messages for a bot account.", [
		{
			noun: "message",
			scope: { channel_id: P("Channel snowflake ID") },
			fields: { content: P("Message content (max 2000 characters)"), reply_to: P("Message ID to reply to") },
			ops: ["list", "create", "delete"],
			required: ["content"],
		},
		{
			noun: "channel",
			scope: { guild_id: P("Server (guild) snowflake ID") },
			fields: { name: P("Channel name"), topic: P("Channel topic") },
			ops: ["list", "get", "create"],
			required: ["name"],
		},
		{ noun: "member", scope: { guild_id: P("Server (guild) snowflake ID") }, fields: {}, ops: ["list", "get"] },
	]),
	generated("datadog", "Datadog", "Datadog metrics, monitors, logs and dashboards.", [
		{
			noun: "monitor",
			scope: {},
			fields: {
				name: P("Monitor name"),
				type: P("Monitor type, e.g. metric alert"),
				query: P("Monitor query"),
				message: P("Notification message, may include @-handles"),
				tags: ["string[]", "Tags"],
			},
			ops: ["list", "get", "create", "update", "delete"],
			required: ["name", "type", "query"],
		},
		{ noun: "log", scope: {}, fields: {}, ops: ["search"] },
		{
			noun: "dashboard",
			scope: {},
			fields: { title: P("Dashboard title"), widgets: ["array", "Widget definitions", { items: { type: "object" } }] },
			ops: ["list", "get"],
		},
		{ noun: "metric", scope: {}, fields: {}, ops: ["search"] },
	]),
	generated("pagerduty", "PagerDuty", "PagerDuty incidents, services, schedules and on-call.", [
		{
			noun: "incident",
			scope: {},
			fields: {
				title: P("Incident title"),
				service_id: P("Service ID"),
				urgency: ["string", "Urgency", { enum: ["high", "low"] }],
				body: P("Incident details"),
			},
			ops: ["list", "get", "create", "update"],
			required: ["title", "service_id"],
		},
		{ noun: "service", scope: {}, fields: {}, ops: ["list", "get"] },
		{ noun: "oncall", plural: "oncalls", scope: {}, fields: {}, ops: ["list"] },
		{ noun: "schedule", scope: {}, fields: {}, ops: ["list", "get"] },
	]),
	generated("supabase", "Supabase", "Supabase projects, SQL, migrations, edge functions and logs.", [
		{
			noun: "project",
			scope: {},
			fields: { name: P("Project name"), region: P("Region, e.g. us-east-1"), organization_id: P("Organization ID") },
			ops: ["list", "get", "create"],
			required: ["name", "region", "organization_id"],
		},
		{
			noun: "migration",
			scope: { project_id: P("Project ref") },
			fields: { name: P("Migration name in snake_case"), query: P("SQL to apply") },
			ops: ["list", "create"],
			required: ["name", "query"],
		},
		{
			noun: "edge function",
			scope: { project_id: P("Project ref") },
			fields: { name: P("Function name"), files: ["array", "Function source files", { items: { type: "object" } }] },
			ops: ["list", "create"],
			required: ["name", "files"],
		},
		{ noun: "table", scope: { project_id: P("Project ref") }, fields: {}, ops: ["list"] },
	]),
	generated("postgres", "PostgreSQL", "Read-only SQL queries and schema inspection against a PostgreSQL database.", [
		{ noun: "schema", scope: {}, fields: {}, ops: ["list"] },
		{ noun: "table", scope: { schema: P("Schema name, default public") }, fields: {}, ops: ["list", "get"] },
		{
			noun: "query",
			plural: "queries",
			scope: {},
			fields: { sql: P("A single read-only SQL statement"), params: ["array", "Positional parameters", { items: {} }] },
			ops: ["create"],
			required: ["sql"],
		},
		{ noun: "index", plural: "indexes", scope: { table: P("Table name") }, fields: {}, ops: ["list"] },
	]),
	generated("mongodb", "MongoDB", "Collections, documents and aggregations in MongoDB.", [
		{
			noun: "collection",
			scope: { database: P("Database name") },
			fields: { name: P("Collection name") },
			ops: ["list", "create", "delete"],
			required: ["name"],
		},
		{
			noun: "document",
			scope: { database: P("Database name"), collection: P("Collection name") },
			fields: { filter: ["object", "Query filter"], update: ["object", "Update document"], document: ["object", "Document to insert"] },
			ops: ["search", "create", "update", "delete"],
		},
		{
			noun: "aggregation",
			scope: { database: P("Database name"), collection: P("Collection name") },
			fields: { pipeline: ["array", "Aggregation pipeline stages", { items: { type: "object" } }] },
			ops: ["create"],
			required: ["pipeline"],
		},
	]),
	generated("redis", "Redis", "Keys, hashes, lists and streams in a Redis instance.", [
		{
			noun: "key",
			scope: {},
			fields: { key: P("Key name"), value: P("String value"), ttl_seconds: ["number", "Expiry in seconds"] },
			ops: ["search", "get", "create", "delete"],
			required: ["key", "value"],
		},
		{ noun: "hash", plural: "hashes", scope: { key: P("Hash key") }, fields: { field: P("Field name"), value: P("Field value") }, ops: ["get", "update"] },
		{
			noun: "stream entry",
			plural: "stream entries",
			scope: { stream: P("Stream key") },
			fields: { fields: ["object", "Entry fields"] },
			ops: ["list", "create"],
			required: ["fields"],
		},
	]),
	generated("google-drive", "Google Drive", "Files and folders in Google Drive, including Docs and Sheets export.", [
		{
			noun: "file",
			scope: {},
			fields: { name: P("File name"), mime_type: P("MIME type"), parent_folder_id: P("Folder to put it in"), content: P("Text content") },
			ops: ["search", "get", "create", "update", "delete"],
			required: ["name"],
		},
		{ noun: "folder", scope: {}, fields: { name: P("Folder name"), parent_folder_id: P("Parent folder ID") }, ops: ["list", "create"], required: ["name"] },
		{
			noun: "permission",
			scope: { file_id: P("File ID") },
			fields: { email: P("Email to share with"), role: ["string", "Role", { enum: ["reader", "commenter", "writer"] }] },
			ops: ["list", "create"],
			required: ["email", "role"],
		},
	]),
	generated("google-calendar", "Google Calendar", "Calendars, events and free/busy in Google Calendar.", [
		{
			noun: "event",
			scope: { calendar_id: P("Calendar ID, 'primary' for the user's calendar") },
			fields: {
				summary: P("Event title"),
				start: P("Start, RFC 3339"),
				end: P("End, RFC 3339"),
				attendees: ["string[]", "Attendee emails"],
				location: P("Location"),
			},
			ops: ["list", "get", "create", "update", "delete"],
			required: ["summary", "start", "end"],
		},
		{ noun: "calendar", scope: {}, fields: {}, ops: ["list"] },
		{ noun: "free busy", plural: "free busy", scope: {}, fields: {}, ops: ["search"] },
	]),
	generated("gmail", "Gmail", "Read, search, draft and send email in Gmail.", [
		{
			noun: "message",
			scope: {},
			fields: { to: ["string[]", "Recipients"], subject: P("Subject"), body: P("Plain-text body"), cc: ["string[]", "CC recipients"] },
			ops: ["search", "get", "create"],
			required: ["to", "subject", "body"],
		},
		{
			noun: "draft",
			scope: {},
			fields: { to: ["string[]", "Recipients"], subject: P("Subject"), body: P("Plain-text body") },
			ops: ["list", "create", "delete"],
			required: ["to", "subject", "body"],
		},
		{ noun: "label", scope: {}, fields: { name: P("Label name") }, ops: ["list", "create"], required: ["name"] },
	]),
	generated("stripe", "Stripe", "Stripe customers, payments, invoices, subscriptions and refunds.", [
		{
			noun: "customer",
			scope: {},
			fields: { email: P("Customer email"), name: P("Customer name"), metadata: ["object", "Key/value metadata"] },
			ops: ["list", "get", "create", "update"],
		},
		{
			noun: "invoice",
			scope: {},
			fields: { customer: P("Customer ID"), auto_advance: ["boolean", "Finalize automatically"], days_until_due: ["number", "Days until due"] },
			ops: ["list", "create"],
			required: ["customer"],
		},
		{
			noun: "refund",
			scope: {},
			fields: {
				payment_intent: P("PaymentIntent ID"),
				amount: ["number", "Amount in the smallest currency unit"],
				reason: ["string", "Reason", { enum: ["duplicate", "fraudulent", "requested_by_customer"] }],
			},
			ops: ["create"],
			required: ["payment_intent"],
		},
		{ noun: "subscription", scope: {}, fields: { customer: P("Customer ID"), price: P("Price ID") }, ops: ["list", "delete"] },
	]),
	generated("shopify", "Shopify", "Products, orders, customers and inventory in a Shopify store.", [
		{
			noun: "product",
			scope: {},
			fields: { title: P("Product title"), body_html: P("Description HTML"), vendor: P("Vendor"), tags: ["string[]", "Tags"] },
			ops: ["search", "get", "create", "update"],
			required: ["title"],
		},
		{ noun: "order", scope: {}, fields: { note: P("Order note"), tags: ["string[]", "Tags"] }, ops: ["list", "get", "update"] },
		{
			noun: "inventory level",
			scope: { location_id: P("Location ID") },
			fields: { inventory_item_id: P("Inventory item ID"), available: ["number", "Available quantity"] },
			ops: ["list", "update"],
		},
	]),
	generated("hubspot", "HubSpot", "HubSpot CRM contacts, companies, deals and engagements.", [
		{
			noun: "contact",
			scope: {},
			fields: { email: P("Email"), firstname: P("First name"), lastname: P("Last name"), company: P("Company name") },
			ops: ["search", "get", "create", "update"],
			required: ["email"],
		},
		{
			noun: "deal",
			scope: {},
			fields: { dealname: P("Deal name"), amount: ["number", "Amount"], dealstage: P("Pipeline stage ID"), pipeline: P("Pipeline ID") },
			ops: ["search", "create", "update"],
			required: ["dealname"],
		},
		{ noun: "company", plural: "companies", scope: {}, fields: { name: P("Company name"), domain: P("Domain") }, ops: ["search", "get"] },
	]),
	generated("salesforce", "Salesforce", "Salesforce records, SOQL queries and object metadata.", [
		{
			noun: "record",
			scope: { object: P("sObject API name, e.g. Account") },
			fields: { fields: ["object", "Field values by API name"] },
			ops: ["get", "create", "update", "delete"],
			required: ["fields"],
		},
		{ noun: "soql query", plural: "soql queries", scope: {}, fields: { soql: P("SOQL statement") }, ops: ["create"], required: ["soql"] },
		{ noun: "object", scope: {}, fields: {}, ops: ["list", "get"] },
	]),
	generated("zendesk", "Zendesk", "Zendesk support tickets, users and macros.", [
		{
			noun: "ticket",
			scope: {},
			fields: {
				subject: P("Ticket subject"),
				comment: P("Comment body"),
				priority: ["string", "Priority", { enum: ["low", "normal", "high", "urgent"] }],
				status: ["string", "Status", { enum: ["new", "open", "pending", "solved"] }],
				assignee_id: ["number", "Agent user ID"],
			},
			ops: ["search", "get", "create", "update"],
			required: ["subject", "comment"],
		},
		{ noun: "user", scope: {}, fields: {}, ops: ["search", "get"] },
		{ noun: "macro", scope: {}, fields: {}, ops: ["list"] },
	]),
	generated("figma", "Figma", "Figma files, nodes, components, comments and image export.", [
		{ noun: "file", scope: {}, fields: {}, ops: ["get"] },
		{ noun: "node", scope: { file_key: P("File key from the Figma URL") }, fields: {}, ops: ["get"] },
		{
			noun: "image",
			scope: { file_key: P("File key from the Figma URL") },
			fields: {
				ids: ["string[]", "Node IDs to render"],
				format: ["string", "Format", { enum: ["png", "jpg", "svg", "pdf"] }],
				scale: ["number", "Scale 0.01–4"],
			},
			ops: ["create"],
			required: ["ids"],
		},
		{
			noun: "comment",
			scope: { file_key: P("File key from the Figma URL") },
			fields: { message: P("Comment text"), node_id: P("Node to attach to") },
			ops: ["list", "create"],
			required: ["message"],
		},
		{ noun: "component", scope: { file_key: P("File key from the Figma URL") }, fields: {}, ops: ["list"] },
	]),
	generated("vercel", "Vercel", "Vercel projects, deployments, domains and environment variables.", [
		{
			noun: "deployment",
			scope: { project_id: P("Project ID or name") },
			fields: { target: ["string", "Target", { enum: ["production", "preview"] }], git_ref: P("Git ref to deploy") },
			ops: ["list", "get", "create"],
			required: ["git_ref"],
		},
		{ noun: "project", scope: {}, fields: {}, ops: ["list", "get"] },
		{
			noun: "env var",
			scope: { project_id: P("Project ID or name") },
			fields: { key: P("Variable name"), value: P("Variable value"), target: ["string[]", "Environments"] },
			ops: ["list", "create", "delete"],
			required: ["key", "value"],
		},
	]),
	generated("cloudflare", "Cloudflare", "Cloudflare Workers, KV, DNS records and zones.", [
		{
			noun: "dns record",
			scope: { zone_id: P("Zone ID") },
			fields: { type: P("Record type, e.g. A, CNAME"), name: P("Record name"), content: P("Record content"), proxied: ["boolean", "Proxy through Cloudflare"] },
			ops: ["list", "create", "update", "delete"],
			required: ["type", "name", "content"],
		},
		{ noun: "worker", scope: { account_id: P("Account ID") }, fields: {}, ops: ["list", "get"] },
		{ noun: "kv namespace", scope: { account_id: P("Account ID") }, fields: { title: P("Namespace title") }, ops: ["list", "create"], required: ["title"] },
		{ noun: "zone", scope: {}, fields: {}, ops: ["list"] },
	]),
	generated("aws-s3", "AWS S3", "Buckets and objects in Amazon S3.", [
		{ noun: "bucket", scope: {}, fields: { name: P("Bucket name"), region: P("AWS region") }, ops: ["list", "create"], required: ["name"] },
		{
			noun: "object",
			scope: { bucket: P("Bucket name") },
			fields: { key: P("Object key"), body: P("Object content"), content_type: P("Content-Type") },
			ops: ["list", "get", "create", "delete"],
			required: ["key", "body"],
		},
		{
			noun: "presigned url",
			scope: { bucket: P("Bucket name") },
			fields: { key: P("Object key"), expires_in: ["number", "Seconds until expiry"] },
			ops: ["create"],
			required: ["key"],
		},
	]),
	generated("kubernetes", "Kubernetes", "Pods, deployments, services and logs in a Kubernetes cluster.", [
		{ noun: "pod", scope: { namespace: P("Namespace, default 'default'") }, fields: {}, ops: ["list", "get", "delete"] },
		{
			noun: "deployment",
			scope: { namespace: P("Namespace, default 'default'") },
			fields: { replicas: ["number", "Desired replica count"], image: P("Container image") },
			ops: ["list", "get", "update"],
		},
		{ noun: "pod log", scope: { namespace: P("Namespace"), pod: P("Pod name") }, fields: {}, ops: ["get"] },
		{ noun: "service", scope: { namespace: P("Namespace") }, fields: {}, ops: ["list"] },
	]),
	generated("docker", "Docker", "Containers, images, volumes and networks on the local Docker engine.", [
		{
			noun: "container",
			scope: {},
			fields: { image: P("Image to run"), name: P("Container name"), ports: ["object", "Port bindings"], env: ["object", "Environment variables"] },
			ops: ["list", "get", "create", "delete"],
			required: ["image"],
		},
		{ noun: "image", scope: {}, fields: { reference: P("Image reference to pull") }, ops: ["list", "create", "delete"], required: ["reference"] },
		{ noun: "volume", scope: {}, fields: {}, ops: ["list"] },
	]),
	generated("airtable", "Airtable", "Airtable bases, tables and records.", [
		{ noun: "base", scope: {}, fields: {}, ops: ["list"] },
		{ noun: "table", scope: { base_id: P("Base ID") }, fields: {}, ops: ["list"] },
		{
			noun: "record",
			scope: { base_id: P("Base ID"), table: P("Table name or ID") },
			fields: { fields: ["object", "Field values by field name"] },
			ops: ["search", "get", "create", "update", "delete"],
			required: ["fields"],
		},
	]),
];

export const FIXTURE_SERVERS: FixtureServer[] = [github, linear, notion, slack, sentry, ...rest];

/** 会话中途新连上的那一台：不在上面那 30 台里。 */
export const TWILIO: FixtureServer = {
	id: "twilio",
	name: "Twilio",
	description: "Send and read SMS messages through Twilio.",
	tools: [
		tool(
			"send_sms",
			"Send an SMS message.",
			{ to: ["string", "Recipient phone number, E.164"], from: ["string", "Sender phone number, E.164"], body: ["string", "Message text"] },
			["to", "from", "body"],
		),
		tool("list_messages", "List recent SMS messages.", { to: ["string", "Filter by recipient"], limit: ["number", "How many"] }, [], READ),
		tool("get_message", "Get one SMS message by SID.", { sid: ["string", "Message SID"] }, ["sid"], READ),
	],
};

export function fixtureServer(id: string): FixtureServer | undefined {
	return [...FIXTURE_SERVERS, TWILIO].find((server) => server.id === id);
}
