/**
 * GitHub API response and internal types for the PRISM MCP Server.
 */

/** Result of fetching a single file from GitHub */
export interface FileResult {
  content: string;
  sha: string;
  size: number;
}

/** Result of pushing a single file to GitHub */
export interface PushResult {
  success: boolean;
  size: number;
  sha: string;
  error?: string;
}

/** Input for a batch file push */
export interface PushFileInput {
  path: string;
  content: string;
  message: string;
}

/** Result of a batch file push, per file */
export interface BatchPushResult extends PushResult {
  path: string;
}

/** GitHub Contents API response (JSON mode, for SHA retrieval) */
export interface GitHubContentsResponse {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string;
  content?: string;
  encoding?: string;
}

/** GitHub PUT contents response */
export interface GitHubPutResponse {
  content: {
    sha: string;
    size: number;
  };
}

/** GitHub error response */
export interface GitHubErrorResponse {
  message: string;
  documentation_url?: string;
}

/** GitHub repository list item */
export interface GitHubRepoListItem {
  name: string;
  full_name: string;
  private: boolean;
}

/** Directory listing entry from GitHub Contents API */
export interface DirectoryEntry {
  name: string;
  path: string;
  size: number;
  sha: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

/** Commit summary from GitHub Commits API */
export interface CommitSummary {
  sha: string;
  message: string;
  date: string;
  files: string[];
}

/** GitHub commit list item */
export interface GitHubCommitListItem {
  sha: string;
  commit: {
    message: string;
    author: {
      date: string;
    };
  };
  files?: Array<{
    filename: string;
  }>;
}
