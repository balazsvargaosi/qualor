CREATE TABLE "review_snapshot_files" (
	"snapshot_id" uuid NOT NULL,
	"path" text NOT NULL,
	"text" text,
	"bytes" integer DEFAULT 0 NOT NULL,
	"omitted" text,
	"change" text,
	"old_path" text,
	"patch" text,
	"since" jsonb,
	CONSTRAINT "review_snapshot_files_snapshot_id_path_pk" PRIMARY KEY("snapshot_id","path"),
	CONSTRAINT "review_snapshot_files_omitted_check" CHECK (omitted IN ('binary','too_large','excluded','credentials','symlink','submodule','limit','not_utf8')),
	CONSTRAINT "review_snapshot_files_change_check" CHECK (change IN ('added','modified','renamed','deleted')),
	CONSTRAINT "review_snapshot_files_omitted_has_no_text" CHECK (text IS NULL OR omitted IS NULL),
	CONSTRAINT "review_snapshot_files_deleted_has_no_text" CHECK (change IS DISTINCT FROM 'deleted' OR text IS NULL)
);
--> statement-breakpoint
CREATE TABLE "review_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"analysis_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"branch_id" uuid,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"error" text,
	"body" "bytea",
	"compressed_bytes" integer NOT NULL,
	"inflated_bytes" bigint,
	"head_sha" text,
	"base_sha" text,
	"since_sha" text,
	"target_branch" text,
	"mr_title" text,
	"mr_description" text,
	"instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unpacked_at" timestamp with time zone,
	CONSTRAINT "review_snapshots_analysis_id_unique" UNIQUE("analysis_id"),
	CONSTRAINT "review_snapshots_status_check" CHECK (status IN ('uploaded','ready','rejected')),
	CONSTRAINT "review_snapshots_body_by_status" CHECK ((status = 'uploaded') = (body IS NOT NULL)),
	CONSTRAINT "review_snapshots_head_sha_format" CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_snapshots_base_sha_format" CHECK (base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "review_snapshots_since_sha_format" CHECK (since_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$')
);
--> statement-breakpoint
ALTER TABLE "review_snapshot_files" ADD CONSTRAINT "review_snapshot_files_snapshot_id_review_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."review_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_snapshots" ADD CONSTRAINT "review_snapshots_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_snapshots" ADD CONSTRAINT "review_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_snapshots" ADD CONSTRAINT "review_snapshots_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_snapshots_branch_idx" ON "review_snapshots" USING btree ("branch_id") WHERE branch_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "review_snapshots_project_idx" ON "review_snapshots" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "review_snapshots_created_idx" ON "review_snapshots" USING btree ("created_at");