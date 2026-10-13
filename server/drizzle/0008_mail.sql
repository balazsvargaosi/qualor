CREATE TABLE "mail_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"to_address" "citext" NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"smtp_response" text,
	"payload_enc" jsonb,
	"dedupe_key" text,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_messages_kind_check" CHECK (kind ~ '^[a-z0-9.-]{1,64}$'),
	CONSTRAINT "mail_messages_status_check" CHECK (status IN ('pending','sent','failed')),
	CONSTRAINT "mail_messages_subject_length" CHECK (char_length(subject) <= 300),
	CONSTRAINT "mail_messages_last_error_length" CHECK (octet_length(last_error) <= 1024),
	CONSTRAINT "mail_messages_smtp_response_length" CHECK (octet_length(smtp_response) <= 1024),
	CONSTRAINT "mail_messages_dedupe_key_length" CHECK (char_length(dedupe_key) <= 200),
	CONSTRAINT "mail_messages_payload_check" CHECK (payload_enc IS NULL OR status = 'pending')
);
--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_messages_log_idx" ON "mail_messages" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mail_messages_dedupe_idx" ON "mail_messages" USING btree ("dedupe_key","created_at") WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "mail_messages_pending_idx" ON "mail_messages" USING btree ("status") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "mail_messages_user_idx" ON "mail_messages" USING btree ("user_id") WHERE user_id IS NOT NULL;