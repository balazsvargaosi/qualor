CREATE TABLE "review_findings" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"assumption" text,
	"verification" text,
	"suggestion" jsonb,
	"anchor_line" integer,
	"reviewed_head_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_findings_category_check" CHECK (category IN ('logic','error-handling','compatibility','concurrency','security','performance','tests','docs')),
	CONSTRAINT "review_findings_body_length" CHECK (char_length(body) <= 2000),
	CONSTRAINT "review_findings_assumption_length" CHECK (char_length(assumption) <= 300),
	CONSTRAINT "review_findings_verification_check" CHECK (verification IN ('confirmed','needs_validation')),
	CONSTRAINT "review_findings_reviewed_head_sha_format" CHECK (reviewed_head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
);
--> statement-breakpoint
CREATE TABLE "review_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"analysis_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"status" text DEFAULT 'waiting' NOT NULL,
	"phase" text,
	"reason" text,
	"detail" text,
	"head_sha" text,
	"since_sha" text,
	"diff_digest" char(64),
	"tier" text,
	"reviewers" text[] DEFAULT '{}'::text[] NOT NULL,
	"provider_host" text,
	"model" text,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint,
	"token_limit_reached" boolean DEFAULT false NOT NULL,
	"snapshot_partial" boolean DEFAULT false NOT NULL,
	"summary" jsonb,
	"findings_new" integer DEFAULT 0 NOT NULL,
	"findings_open" integer DEFAULT 0 NOT NULL,
	"findings_fixed" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "review_runs_analysis_id_unique" UNIQUE("analysis_id"),
	CONSTRAINT "review_runs_status_check" CHECK (status IN ('waiting','running','done','skipped','failed','superseded')),
	CONSTRAINT "review_runs_phase_check" CHECK (phase IN ('specialists','judge','verification','storing')),
	CONSTRAINT "review_runs_phase_only_while_running" CHECK (phase IS NULL OR status = 'running'),
	CONSTRAINT "review_runs_reason_by_status" CHECK (CASE status WHEN 'skipped' THEN reason IS NOT NULL AND reason IN ('no_snapshot','snapshot_rejected','draft','closed','inactive','empty_diff','unchanged','budget_spent') WHEN 'failed' THEN reason IS NOT NULL AND reason IN ('provider_error','provider_no_tools','bad_answer','internal') ELSE reason IS NULL END),
	CONSTRAINT "review_runs_detail_length" CHECK (char_length(detail) <= 200),
	CONSTRAINT "review_runs_head_sha_format" CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_runs_since_sha_format" CHECK (since_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_runs_diff_digest_format" CHECK (diff_digest ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "review_runs_tier_check" CHECK (tier IN ('trivial','lite','full'))
);
--> statement-breakpoint
ALTER TABLE "llm_requests" DROP CONSTRAINT "llm_requests_feature_check";--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_run_id_review_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."review_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_snapshot_id_review_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."review_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_findings_run_idx" ON "review_findings" USING btree ("run_id") WHERE run_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "review_runs_branch_idx" ON "review_runs" USING btree ("branch_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "review_runs_project_idx" ON "review_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "review_runs_snapshot_idx" ON "review_runs" USING btree ("snapshot_id") WHERE snapshot_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "review_runs_active_idx" ON "review_runs" USING btree ("status") WHERE status IN ('waiting','running');--> statement-breakpoint
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_feature_check" CHECK (feature IN ('explain','triage','fix','review'));