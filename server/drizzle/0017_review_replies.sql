CREATE TABLE "review_replies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"note_id" bigint NOT NULL,
	"thread_id" text,
	"issue_id" uuid,
	"kind" text NOT NULL,
	"command" text,
	"author" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"outcome" text,
	"reason" text,
	"verdict" text,
	"answer" text,
	"answer_note_id" bigint,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "review_replies_note_unique" UNIQUE("project_id","provider","kind","note_id"),
	CONSTRAINT "review_replies_provider_check" CHECK (provider IN ('gitlab','github')),
	CONSTRAINT "review_replies_kind_check" CHECK (kind IN ('reply','command')),
	CONSTRAINT "review_replies_command_check" CHECK (command IN ('review','fix','stop')),
	CONSTRAINT "review_replies_command_by_kind" CHECK ((kind = 'command') = (command IS NOT NULL)),
	CONSTRAINT "review_replies_author_length" CHECK (char_length(author) <= 255),
	CONSTRAINT "review_replies_status_check" CHECK (status IN ('queued','running','done','skipped','failed')),
	CONSTRAINT "review_replies_finished_by_status" CHECK ((status IN ('done','skipped','failed')) = (finished_at IS NOT NULL)),
	CONSTRAINT "review_replies_outcome_check" CHECK (outcome IN ('answered','acknowledged','explained','wont_fix','false_positive','review_requested','in_progress','already_reviewed','not_available','review_off')),
	CONSTRAINT "review_replies_reason_check" CHECK (reason IN ('budget_spent','inactive','closed','thread_gone','provider_error','provider_no_tools','bad_answer','internal')),
	CONSTRAINT "review_replies_verdict_check" CHECK (verdict IN ('keep','wont_fix','false_positive')),
	CONSTRAINT "review_replies_answer_length" CHECK (char_length(answer) <= 1200),
	CONSTRAINT "review_replies_thread_id_format" CHECK (thread_id ~ '^[0-9a-f]{1,64}$|^[0-9]{1,20}$')
);
--> statement-breakpoint
ALTER TABLE "llm_requests" DROP CONSTRAINT "llm_requests_feature_check";--> statement-breakpoint
ALTER TABLE "scm_connections" DROP CONSTRAINT "scm_connections_github_app_check";--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_replies" ADD CONSTRAINT "review_replies_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_replies_thread_idx" ON "review_replies" USING btree ("branch_id","thread_id","note_id");--> statement-breakpoint
CREATE INDEX "review_replies_issue_idx" ON "review_replies" USING btree ("issue_id") WHERE issue_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_feature_check" CHECK (feature IN ('explain','triage','fix','review','review-reply'));--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_requested_by_length" CHECK (char_length(requested_by) <= 255);--> statement-breakpoint
ALTER TABLE "scm_connections" ADD CONSTRAINT "scm_connections_github_app_check" CHECK ((provider = 'gitlab' AND app_id IS NULL) OR (provider = 'github' AND app_id IS NOT NULL AND app_id ~ '^[0-9]{1,20}$'));