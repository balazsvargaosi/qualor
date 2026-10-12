CREATE TABLE "compliance_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"branch_id" uuid,
	"scope" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"standards" jsonb NOT NULL,
	"summary" jsonb,
	"data" "bytea",
	"sha256" char(64),
	"size_bytes" integer,
	"error" text,
	CONSTRAINT "compliance_reports_scope_check" CHECK ((scope = 'project' AND project_id IS NOT NULL) OR (scope = 'organization' AND project_id IS NULL)),
	CONSTRAINT "compliance_reports_status_check" CHECK (status IN ('pending','ready','failed')),
	CONSTRAINT "compliance_reports_ready_check" CHECK (status <> 'ready' OR (data IS NOT NULL AND sha256 IS NOT NULL AND summary IS NOT NULL AND completed_at IS NOT NULL AND size_bytes IS NOT NULL)),
	CONSTRAINT "compliance_reports_sha256_format" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "compliance_reports_summary_size" CHECK (octet_length(summary::text) <= 65536),
	CONSTRAINT "compliance_reports_error_length" CHECK (char_length(error) <= 500),
	CONSTRAINT "compliance_reports_name_length" CHECK (char_length(created_by_name) <= 255)
);
--> statement-breakpoint
ALTER TABLE "compliance_reports" ADD CONSTRAINT "compliance_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_reports" ADD CONSTRAINT "compliance_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_reports" ADD CONSTRAINT "compliance_reports_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_reports" ADD CONSTRAINT "compliance_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_reports_organization_idx" ON "compliance_reports" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "compliance_reports_project_idx" ON "compliance_reports" USING btree ("project_id","id") WHERE project_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "compliance_reports_branch_idx" ON "compliance_reports" USING btree ("branch_id") WHERE branch_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "compliance_reports_created_by_idx" ON "compliance_reports" USING btree ("created_by") WHERE created_by IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_reports_pending_key" ON "compliance_reports" USING btree ("organization_id",coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'pending';