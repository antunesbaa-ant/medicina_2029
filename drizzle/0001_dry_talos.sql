ALTER TABLE "perfis" ADD COLUMN "email" varchar(255);--> statement-breakpoint
ALTER TABLE "perfis" ADD COLUMN "password_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "perfis" ADD CONSTRAINT "perfis_email_unique" UNIQUE("email");