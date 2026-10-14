CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email" boolean DEFAULT true NOT NULL,
	"org_webhook_failures" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_watches" (
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"branches" text DEFAULT 'main' NOT NULL,
	"gate_failed" boolean DEFAULT true NOT NULL,
	"gate_recovered" boolean DEFAULT true NOT NULL,
	"analysis_failed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_watches_user_id_project_id_pk" PRIMARY KEY("user_id","project_id"),
	CONSTRAINT "project_watches_branches_check" CHECK (branches IN ('main','all'))
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_watches" ADD CONSTRAINT "project_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_watches" ADD CONSTRAINT "project_watches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_watches_project_idx" ON "project_watches" USING btree ("project_id");