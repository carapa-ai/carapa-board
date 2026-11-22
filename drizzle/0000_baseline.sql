CREATE TABLE "active_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"group_folder" text NOT NULL,
	"chat_jid" text NOT NULL,
	"session_id" text,
	"is_main" integer DEFAULT 0,
	"is_scheduled_task" integer DEFAULT 0,
	"scheduled_task_id" text,
	"task_id" text,
	"sandbox_stack" text NOT NULL,
	"sandbox_service" text NOT NULL,
	"sandbox_instance" text,
	"started_at" text NOT NULL,
	"timeout_at" text NOT NULL,
	"last_event_at" text,
	"status" text DEFAULT 'running',
	"model" text,
	"stage" text,
	"conversation_id" text,
	"agent_name" text,
	"agent_ask_id" text,
	"session_agent_key" text,
	"runtime_variant" text,
	"restart_recovery_of_run_id" text,
	"restart_recovery_dispatched_at" text,
	"completed_at" text,
	"tok_total" integer,
	"tok_output" integer,
	"tok_input" integer,
	"tok_cache_write" integer,
	"tok_cache_read" integer,
	"tok_context_last" integer,
	"model_name" text,
	"tool_usage_count" integer,
	"cost_usd" real,
	"result" text,
	"review_score" real,
	"testing_decision" text,
	"triggered_by_user_id" text,
	"trigger_source" text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_asks" (
	"id" text PRIMARY KEY NOT NULL,
	"caller_project_id" text NOT NULL,
	"caller_conversation_id" text,
	"caller_objective_id" text,
	"caller_run_id" text,
	"caller_name" text NOT NULL,
	"owner_user_id" text,
	"target_project_id" text NOT NULL,
	"target_conversation_id" text NOT NULL,
	"ask_message_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	"settled_at" text,
	"delivery_error" text
);
--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"expires_at" bigint,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_turn_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"ai_user_id" text NOT NULL,
	"phase" text NOT NULL,
	"preset_id" text NOT NULL,
	"effective_toolsets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" text,
	"inspection" jsonb,
	"status" text NOT NULL,
	"stop_reason" text,
	"created_at" text NOT NULL,
	"started_at" text,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "ai_user_team_members" (
	"team_id" text NOT NULL,
	"ai_user_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "ai_user_team_members_team_id_ai_user_id_pk" PRIMARY KEY("team_id","ai_user_id")
);
--> statement-breakpoint
CREATE TABLE "ai_user_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"preset_id" text NOT NULL,
	"prompt_path" text NOT NULL,
	"avatar_path" text,
	"voice_id" text,
	"voice_lang" text,
	"voice_style_path" text,
	"identity" text NOT NULL,
	"turn" text DEFAULT 'after' NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"published_emotes" jsonb,
	"persona_revision" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boxes" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"kind" text DEFAULT 'docker' NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"isolation_level" text DEFAULT 'container' NOT NULL,
	"version" text,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text,
	"revoked_at" text,
	CONSTRAINT "boxes_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "conversation_agent_sessions" (
	"conversation_id" text NOT NULL,
	"agent_cmd" text NOT NULL,
	"session_id" text,
	"chat_mode" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "conversation_agent_sessions_conversation_id_agent_cmd_pk" PRIMARY KEY("conversation_id","agent_cmd")
);
--> statement-breakpoint
CREATE TABLE "conversation_ai_users" (
	"conversation_id" text NOT NULL,
	"ai_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" text,
	"invited_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "conversation_ai_users_conversation_id_ai_user_id_pk" PRIMARY KEY("conversation_id","ai_user_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_execution_leases" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"acquired_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_live_queue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"sequence" integer NOT NULL,
	"participant_id" text NOT NULL,
	"message_id" text NOT NULL,
	"state" text NOT NULL,
	"asset_id" text,
	"duration_ms" integer,
	"released_at" text,
	"started_at" text,
	"ends_at" text,
	"error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_live_runs" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"mode" text DEFAULT 'personas' NOT NULL,
	"status" text DEFAULT 'off' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL,
	"current_item_id" text,
	"leader_user_id" text,
	"leader_device_id" text,
	"leader_session_id" text,
	"leader_platform" text,
	"leader_device_speech" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_expires_at" text,
	"error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"access_level" text DEFAULT 'viewer' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "conversation_members_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_public_shares" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"public_token" text NOT NULL,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"revoked_at" text,
	"allow_visitor_prompts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "conversation_public_shares_public_token_unique" UNIQUE("public_token")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"group_folder" text NOT NULL,
	"preview" text,
	"created_at" text NOT NULL,
	"read_at" text,
	"title" text,
	"pinned" integer DEFAULT 0 NOT NULL,
	"session_id" text,
	"forked_from" text,
	"use_worktree" integer DEFAULT 0 NOT NULL,
	"prompt_cache_1h" integer DEFAULT 0 NOT NULL,
	"worktree_path" text,
	"worktree_missing" integer DEFAULT 0 NOT NULL,
	"branch_name" text,
	"brain_managed" integer DEFAULT 0 NOT NULL,
	"objective_id" text,
	"last_agent_cmd" text,
	"runtime_harness_id" text,
	"runtime_model_id" text,
	"runtime_reasoning" text,
	"routed_model_id" text,
	"routed_harness_id" text,
	"routed_tier" text,
	"routed_at" text,
	"main_ai_user_id" text,
	"main_ai_user_mode" text DEFAULT 'inherit' NOT NULL,
	"main_persona_fingerprint" text,
	"main_persona_source_revision" text,
	"main_persona_generation" integer DEFAULT 0 NOT NULL,
	"continuous_persona_loop" integer DEFAULT 0 NOT NULL,
	"last_user_at" text,
	"last_assistant_at" text,
	"last_assistant_outcome" text,
	"owner_user_id" text,
	"last_triggered_by_user_id" text,
	"last_trigger_source" text DEFAULT 'system' NOT NULL,
	"last_triggered_at" text
);
--> statement-breakpoint
CREATE TABLE "cronjobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cron_expression" text NOT NULL,
	"queue_mode" text DEFAULT 'always' NOT NULL,
	"model" text,
	"agent_name" text,
	"runtime_selection" text,
	"runtime_selection_stage" text,
	"objective_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived" integer DEFAULT 0 NOT NULL,
	"last_run" text,
	"next_run" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"dataset" text NOT NULL,
	"total_rows" integer NOT NULL,
	"completed_rows" integer DEFAULT 0 NOT NULL,
	"current_row_index" integer DEFAULT 0 NOT NULL,
	"spawned_row_index" integer DEFAULT -1 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"model" text,
	"agent_name" text,
	"runtime_selection" text,
	"runtime_selection_stage" text,
	"objective_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_keys" (
	"device_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"kind" text DEFAULT 'interactive' NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_approved" boolean DEFAULT false NOT NULL,
	"approved_at" text,
	"approved_by" text,
	"label" text,
	"created_at" text NOT NULL,
	"last_used_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_pairings" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"public_key" text NOT NULL,
	"label" text NOT NULL,
	"requested_scopes" jsonb NOT NULL,
	"code_hash" text NOT NULL,
	"secret_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"last_polled_at" text,
	"approved_by" text,
	CONSTRAINT "device_pairings_device_id_unique" UNIQUE("device_id"),
	CONSTRAINT "device_pairings_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "device_push_tokens" (
	"device_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_acked_at" text
);
--> statement-breakpoint
CREATE TABLE "external_issue_imports" (
	"project_id" text NOT NULL,
	"provider" text NOT NULL,
	"repository" text NOT NULL,
	"issue_number" integer NOT NULL,
	"task_id" text,
	"issue_url" text NOT NULL,
	"imported_at" text NOT NULL,
	CONSTRAINT "external_issue_imports_project_id_provider_repository_issue_number_pk" PRIMARY KEY("project_id","provider","repository","issue_number")
);
--> statement-breakpoint
CREATE TABLE "external_run_costs" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_session_id" text NOT NULL,
	"external_turn_id" text NOT NULL,
	"group_folder" text NOT NULL,
	"conversation_id" text NOT NULL,
	"started_at" text NOT NULL,
	"completed_at" text,
	"model_name" text,
	"tok_total" integer,
	"tok_input" integer,
	"tok_output" integer,
	"tok_cache_read" integer,
	"tok_reasoning" integer,
	"cost_usd" real,
	"cost_estimated" integer DEFAULT 1 NOT NULL,
	"cost_source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_favorite_moves" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_favorites" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"path" text,
	"kb_id" text,
	"filename" text,
	"created_at" text NOT NULL,
	CONSTRAINT "chk_file_favorites_shape" CHECK (("file_favorites"."kind" = 'group' AND "file_favorites"."path" IS NOT NULL AND "file_favorites"."kb_id" IS NULL AND "file_favorites"."filename" IS NULL)
        OR ("file_favorites"."kind" = 'knowledge' AND "file_favorites"."path" IS NULL AND "file_favorites"."kb_id" IS NOT NULL AND "file_favorites"."filename" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "kb_members" (
	"user_id" text NOT NULL,
	"kb_id" text NOT NULL,
	"access_level" text DEFAULT 'viewer' NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "kb_members_user_id_kb_id_pk" PRIMARY KEY("user_id","kb_id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_base_shares" (
	"knowledge_base_id" text NOT NULL,
	"group_folder" text NOT NULL,
	CONSTRAINT "knowledge_base_shares_knowledge_base_id_group_folder_pk" PRIMARY KEY("knowledge_base_id","group_folder")
);
--> statement-breakpoint
CREATE TABLE "knowledge_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"folder_path" text NOT NULL,
	"last_indexed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"kb_id" text NOT NULL,
	"path" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title" text,
	"description" text,
	"source_url" text,
	"added_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	CONSTRAINT "knowledge_documents_kb_id_path_pk" PRIMARY KEY("kb_id","path")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"group_folder" text NOT NULL,
	"content" text NOT NULL,
	"memory_type" text NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"source" text DEFAULT 'agent',
	"source_ref" text,
	"tags" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_accessed_at" text NOT NULL,
	"access_count" integer DEFAULT 0,
	"superseded_by" text,
	"objective_id" text,
	"valid_from" text,
	"valid_to" text
);
--> statement-breakpoint
CREATE TABLE "memory_audit_items" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"memory_fingerprint" text NOT NULL,
	"processing_state" text DEFAULT 'pending' NOT NULL,
	"disposition" text,
	"confidence" real,
	"reason" text,
	"proposed_content" text,
	"proposed_memory_type" text,
	"proposed_importance" real,
	"proposed_tags" text,
	"merge_target_id" text,
	"target_project_id" text,
	"retrieval_value" text,
	"proposed_valid_from" text,
	"proposal_evidence" text,
	"review_decision" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"applied_at" text,
	"applied_memory_id" text,
	"apply_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"initiated_by" text,
	"runtime_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"mode" text DEFAULT 'cleanup' NOT NULL,
	"status" text NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"processed_items" integer DEFAULT 0 NOT NULL,
	"proposal_items" integer DEFAULT 0 NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"index_collector_token_hash" text,
	"index_collector_finished_at" text,
	"index_collector_summary" text,
	"index_collector_inspected_areas" text,
	"baseline_fingerprint" text NOT NULL,
	"error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"started_at" text,
	"ready_at" text,
	"applied_at" text
);
--> statement-breakpoint
CREATE TABLE "memory_evidence_certificates" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"project_id" text NOT NULL,
	"memory_fingerprint" text NOT NULL,
	"verdict" text NOT NULL,
	"value_justification" text NOT NULL,
	"evidence_type" text NOT NULL,
	"reflector_version" text NOT NULL,
	"origin" text NOT NULL,
	"expires_at" text,
	"revoked_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_evidence_files" (
	"id" text PRIMARY KEY NOT NULL,
	"certificate_id" text NOT NULL,
	"repository_root" text NOT NULL,
	"path" text NOT NULL,
	"file_sha256" text NOT NULL,
	"excerpt_sha256" text NOT NULL,
	"watched_scope" text,
	"watched_scope_sha256" text,
	"line_start" integer,
	"line_end" integer,
	"excerpt" text NOT NULL,
	"repository_commit" text,
	"verified_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_history_apply_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"manifest_id" text NOT NULL,
	"project_id" text NOT NULL,
	"operation_index" integer NOT NULL,
	"request_fingerprint" text NOT NULL,
	"expected_target_version" text,
	"baseline_fingerprint" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_index_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"candidate_key" text NOT NULL,
	"content" text NOT NULL,
	"memory_type" text NOT NULL,
	"importance" real NOT NULL,
	"tags" text NOT NULL,
	"retrieval_value" text NOT NULL,
	"reason" text NOT NULL,
	"valid_from" text NOT NULL,
	"evidence" text NOT NULL,
	"disposition" text DEFAULT 'discovered' NOT NULL,
	"confidence" real,
	"reconciliation_reason" text,
	"target_memory_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_privacy_erasure_marks" (
	"group_folder" text PRIMARY KEY NOT NULL,
	"last_erased_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_reflector_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"target_memory_id" text,
	"result_memory_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_reflector_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"transcript_path" text NOT NULL,
	"transcript_fingerprint" text NOT NULL,
	"byte_offset" integer DEFAULT 0 NOT NULL,
	"profile" text NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"next_chunk_index" integer DEFAULT 0 NOT NULL,
	"total_chunks" integer NOT NULL,
	"origin_scope_known" integer DEFAULT 0 NOT NULL,
	"origin_objective_id" text,
	"origin_conversation_id" text,
	"source_group_folder" text,
	"workspace_root" text,
	"sandbox_stack" text,
	"sandbox_service" text,
	"sandbox_instance" text,
	"sandbox_workspace_path" text,
	"error" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "memory_transcript_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_ref" text NOT NULL,
	"message_id" text NOT NULL,
	"message_created_at" text NOT NULL,
	"excerpt" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_speech_assets" (
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"speaker_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "message_speech_assets_conversation_id_message_id_pk" PRIMARY KEY("conversation_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "notification_payloads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"content" text NOT NULL,
	"action_url" text,
	"respond_to_kind" text,
	"respond_to_id" text,
	"respond_to_objective_id" text,
	"form_response" jsonb,
	"source_tool_use_id" text,
	"created_at" text NOT NULL,
	"delivered_at" text,
	"acked_at" text,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "now_dismissals" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "now_dismissals_user_id_kind_item_id_pk" PRIMARY KEY("user_id","kind","item_id"),
	CONSTRAINT "now_dismissals_kind_check" CHECK ("now_dismissals"."kind" in ('conversation','task'))
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"targets" jsonb NOT NULL,
	"grant_expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"approved_at" text
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"targets" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"expires_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	CONSTRAINT "oauth_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "oauth_tokens_kind_check" CHECK ("oauth_tokens"."kind" in ('access','refresh'))
);
--> statement-breakpoint
CREATE TABLE "objective_task_event_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"objective_id" text NOT NULL,
	"stage_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_timestamp" text NOT NULL,
	"notification" text NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"created_at" text NOT NULL,
	"settled_at" text
);
--> statement-breakpoint
CREATE TABLE "objectives" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"deadline" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"specific" text,
	"measurable" text,
	"achievable" text,
	"relevant" text,
	"time_bound" text,
	"trigger_config" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"metadata" text,
	"event_runtime_selection" jsonb,
	"work_dir" text,
	"cost_limit_usd" real,
	"move_source_project" text,
	CONSTRAINT "objectives_cost_limit_usd_nonnegative" CHECK ("objectives"."cost_limit_usd" IS NULL OR "objectives"."cost_limit_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pending_graph_erasures" (
	"id" text PRIMARY KEY NOT NULL,
	"group_folder" text NOT NULL,
	"target_tokens" text NOT NULL,
	"token_scheme" text DEFAULT 'hmac-sha256' NOT NULL,
	"created_at" text NOT NULL,
	"last_attempt_at" text
);
--> statement-breakpoint
CREATE TABLE "pending_memory_erasures" (
	"memory_id" text PRIMARY KEY NOT NULL,
	"group_folder" text NOT NULL,
	"target_tokens" text DEFAULT '[]' NOT NULL,
	"token_scheme" text DEFAULT 'hmac-sha256' NOT NULL,
	"erase_matching_graph" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"last_attempt_at" text
);
--> statement-breakpoint
CREATE TABLE "pending_memory_invalidations" (
	"memory_id" text PRIMARY KEY NOT NULL,
	"effective_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_member_kanban_acknowledgements" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"event_id" bigint NOT NULL,
	CONSTRAINT "project_member_kanban_acknowledgements_user_id_project_id_event_id_pk" PRIMARY KEY("user_id","project_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"access_level" text DEFAULT 'viewer' NOT NULL,
	"created_at" text NOT NULL,
	"preferences" text,
	"push_enabled" integer,
	"mode" text,
	CONSTRAINT "project_members_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"jid" text NOT NULL,
	"name" text NOT NULL,
	"folder" text NOT NULL,
	"trigger" text NOT NULL,
	"added_at" text NOT NULL,
	"order" integer,
	"parent_id" text,
	"settings" text,
	"is_main" integer DEFAULT 0 NOT NULL,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"objective_id" text,
	"conversation_id" text NOT NULL,
	"created_by_run" text,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"target_layer" text NOT NULL,
	"approve_action" jsonb NOT NULL,
	"deny_action" jsonb,
	"base_hash" text NOT NULL,
	"base_files" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" text,
	"result" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_prompt_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"visitor_hash" text NOT NULL,
	"status" text NOT NULL,
	"safety_category" text,
	"responder_count" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"group_folder" text NOT NULL,
	"chat_jid" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule_type" text NOT NULL,
	"schedule_value" text NOT NULL,
	"next_run" text,
	"last_run" text,
	"last_result" text,
	"status" text DEFAULT 'active',
	"created_at" text NOT NULL,
	"context_mode" text,
	"runtime_selection" jsonb
);
--> statement-breakpoint
CREATE TABLE "stage_entry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"stage_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL,
	"claimed_at" text,
	"run_id" text,
	"completed_at" text,
	"error" text,
	"lifecycle_notification" text
);
--> statement-breakpoint
CREATE TABLE "task_board_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" text GENERATED ALWAYS AS ("snapshot"->>'status') STORED
);
--> statement-breakpoint
CREATE TABLE "task_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"agent_name" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_run_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text,
	"task_id" text NOT NULL,
	"run_at" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text NOT NULL,
	"result" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "task_stage_comments" (
	"task_id" text NOT NULL,
	"stage_id" text NOT NULL,
	"content" text NOT NULL,
	"updated_at" text NOT NULL,
	"run_id" text,
	CONSTRAINT "task_stage_comments_task_id_stage_id_pk" PRIMARY KEY("task_id","stage_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'backlog' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"runtime_selection" text,
	"runtime_selection_stage" text,
	"output" text,
	"error" text,
	"session_id" text,
	"created_at" text NOT NULL,
	"started_at" text,
	"completed_at" text,
	"cronjob_id" text,
	"last_agent_name" text,
	"depends_on_ids" text,
	"archived" integer DEFAULT 0 NOT NULL,
	"custom_values" text,
	"author" text,
	"dataset_task_id" text,
	"dataset_row_index" integer,
	"dataset_generation" integer,
	"branch_name" text,
	"execute_in_stage" text,
	"sandbox_instance" text,
	"worktree_path" text,
	"merge_commit" text,
	"skip_stages" text,
	"stage_variant" text,
	"co_stages" text,
	"ab_variants" text,
	"ab_parent_task_id" text,
	"ab_winner_task_id" text,
	"ab_fork_stage" text,
	"ab_fork_commit" text,
	"objective_id" text,
	"owner_user_id" text,
	"last_triggered_by_user_id" text,
	"last_trigger_source" text DEFAULT 'system' NOT NULL,
	"last_triggered_at" text,
	"source_conversation_id" text,
	"source_run_id" text
);
--> statement-breakpoint
CREATE TABLE "tts_audio_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"format" text NOT NULL,
	"mime_type" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"sample_rate" integer NOT NULL,
	"byte_length" bigint NOT NULL,
	"model" text NOT NULL,
	"voice_id" text NOT NULL,
	"language" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" text NOT NULL,
	"last_accessed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" text NOT NULL,
	"disabled" integer DEFAULT 0 NOT NULL,
	"preferences" text,
	"dictation_language" text,
	"display_name" text,
	"avatar_path" text,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_group_folder_projects_id_fk" FOREIGN KEY ("group_folder") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_scheduled_task_id_scheduled_tasks_id_fk" FOREIGN KEY ("scheduled_task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "active_runs" ADD CONSTRAINT "active_runs_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_asks" ADD CONSTRAINT "agent_asks_caller_project_id_projects_id_fk" FOREIGN KEY ("caller_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_asks" ADD CONSTRAINT "agent_asks_caller_conversation_id_conversations_id_fk" FOREIGN KEY ("caller_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_asks" ADD CONSTRAINT "agent_asks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_asks" ADD CONSTRAINT "agent_asks_target_project_id_projects_id_fk" FOREIGN KEY ("target_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_asks" ADD CONSTRAINT "agent_asks_target_conversation_id_conversations_id_fk" FOREIGN KEY ("target_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_turn_runs" ADD CONSTRAINT "ai_turn_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_turn_runs" ADD CONSTRAINT "ai_turn_runs_ai_user_id_ai_users_id_fk" FOREIGN KEY ("ai_user_id") REFERENCES "public"."ai_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_user_team_members" ADD CONSTRAINT "ai_user_team_members_team_id_ai_user_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."ai_user_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_user_team_members" ADD CONSTRAINT "ai_user_team_members_ai_user_id_ai_users_id_fk" FOREIGN KEY ("ai_user_id") REFERENCES "public"."ai_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_agent_sessions" ADD CONSTRAINT "conversation_agent_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_ai_users" ADD CONSTRAINT "conversation_ai_users_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_ai_users" ADD CONSTRAINT "conversation_ai_users_ai_user_id_ai_users_id_fk" FOREIGN KEY ("ai_user_id") REFERENCES "public"."ai_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_ai_users" ADD CONSTRAINT "conversation_ai_users_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_execution_leases" ADD CONSTRAINT "conversation_execution_leases_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_live_queue_items" ADD CONSTRAINT "conversation_live_queue_items_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_live_queue_items" ADD CONSTRAINT "conversation_live_queue_items_asset_id_tts_audio_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."tts_audio_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_live_runs" ADD CONSTRAINT "conversation_live_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_live_runs" ADD CONSTRAINT "conversation_live_runs_leader_user_id_users_id_fk" FOREIGN KEY ("leader_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_public_shares" ADD CONSTRAINT "conversation_public_shares_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_public_shares" ADD CONSTRAINT "conversation_public_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_group_folder_projects_id_fk" FOREIGN KEY ("group_folder") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_main_ai_user_id_ai_users_id_fk" FOREIGN KEY ("main_ai_user_id") REFERENCES "public"."ai_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_last_triggered_by_user_id_users_id_fk" FOREIGN KEY ("last_triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cronjobs" ADD CONSTRAINT "cronjobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dataset_tasks" ADD CONSTRAINT "dataset_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_keys" ADD CONSTRAINT "device_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_push_tokens" ADD CONSTRAINT "device_push_tokens_device_id_device_keys_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device_keys"("device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_push_tokens" ADD CONSTRAINT "device_push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_issue_imports" ADD CONSTRAINT "external_issue_imports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_issue_imports" ADD CONSTRAINT "external_issue_imports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_run_costs" ADD CONSTRAINT "external_run_costs_group_folder_projects_id_fk" FOREIGN KEY ("group_folder") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_run_costs" ADD CONSTRAINT "external_run_costs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_favorite_moves" ADD CONSTRAINT "file_favorite_moves_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_favorites" ADD CONSTRAINT "file_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_favorites" ADD CONSTRAINT "file_favorites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_favorites" ADD CONSTRAINT "file_favorites_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_members" ADD CONSTRAINT "kb_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_members" ADD CONSTRAINT "kb_members_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_shares" ADD CONSTRAINT "knowledge_base_shares_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_shares" ADD CONSTRAINT "knowledge_base_shares_group_folder_projects_id_fk" FOREIGN KEY ("group_folder") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_kb_id_knowledge_bases_id_fk" FOREIGN KEY ("kb_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_group_folder_projects_id_fk" FOREIGN KEY ("group_folder") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_audit_items" ADD CONSTRAINT "memory_audit_items_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "public"."memory_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_audits" ADD CONSTRAINT "memory_audits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_audits" ADD CONSTRAINT "memory_audits_initiated_by_fkey" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_evidence_certificates" ADD CONSTRAINT "memory_evidence_certificates_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_evidence_certificates" ADD CONSTRAINT "memory_evidence_certificates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_evidence_files" ADD CONSTRAINT "memory_evidence_files_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "public"."memory_evidence_certificates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_history_apply_operations" ADD CONSTRAINT "memory_history_apply_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_index_candidates" ADD CONSTRAINT "memory_index_candidates_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "public"."memory_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_reflector_operations" ADD CONSTRAINT "memory_reflector_operations_run_id_memory_reflector_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."memory_reflector_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_reflector_runs" ADD CONSTRAINT "memory_reflector_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_transcript_evidence" ADD CONSTRAINT "memory_transcript_evidence_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_transcript_evidence" ADD CONSTRAINT "memory_transcript_evidence_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_speech_assets" ADD CONSTRAINT "message_speech_assets_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_speech_assets" ADD CONSTRAINT "message_speech_assets_asset_id_tts_audio_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."tts_audio_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_payloads" ADD CONSTRAINT "notification_payloads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "now_dismissals" ADD CONSTRAINT "now_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_requests" ADD CONSTRAINT "oauth_authorization_requests_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_task_event_holds" ADD CONSTRAINT "objective_task_event_holds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_task_event_holds" ADD CONSTRAINT "objective_task_event_holds_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member_kanban_acknowledgements" ADD CONSTRAINT "project_member_kanban_acknowledgements_event_id_task_board_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."task_board_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_member_kanban_acknowledgements" ADD CONSTRAINT "project_member_kanban_acknowledgements_user_id_project_id_project_members_user_id_project_id_fk" FOREIGN KEY ("user_id","project_id") REFERENCES "public"."project_members"("user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_id_projects_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_prompt_requests" ADD CONSTRAINT "public_prompt_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_group_folder_projects_id_fk" FOREIGN KEY ("group_folder") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entry_events" ADD CONSTRAINT "stage_entry_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entry_events" ADD CONSTRAINT "stage_entry_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entry_events" ADD CONSTRAINT "stage_entry_events_run_id_active_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."active_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_board_events" ADD CONSTRAINT "task_board_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_logs" ADD CONSTRAINT "task_run_logs_run_id_active_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."active_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_logs" ADD CONSTRAINT "task_run_logs_task_id_scheduled_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_stage_comments" ADD CONSTRAINT "task_stage_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_cronjob_id_cronjobs_id_fk" FOREIGN KEY ("cronjob_id") REFERENCES "public"."cronjobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_dataset_task_id_dataset_tasks_id_fk" FOREIGN KEY ("dataset_task_id") REFERENCES "public"."dataset_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_last_triggered_by_user_id_users_id_fk" FOREIGN KEY ("last_triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_run_id_active_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."active_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_active_runs_status" ON "active_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_active_runs_group" ON "active_runs" USING btree ("group_folder");--> statement-breakpoint
CREATE INDEX "idx_active_runs_task" ON "active_runs" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_active_runs_restart_recovery_of" ON "active_runs" USING btree ("restart_recovery_of_run_id");--> statement-breakpoint
CREATE INDEX "idx_active_runs_scheduled_task_started" ON "active_runs" USING btree ("scheduled_task_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_active_runs_last_event" ON "active_runs" USING btree ("status","last_event_at");--> statement-breakpoint
CREATE INDEX "idx_agent_asks_caller_created" ON "agent_asks" USING btree ("caller_project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_asks_target_status" ON "agent_asks" USING btree ("target_project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_asks_pending_target_conversation" ON "agent_asks" USING btree ("target_conversation_id") WHERE "agent_asks"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_agent_tokens_expires_at" ON "agent_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_ai_turn_runs_conversation" ON "ai_turn_runs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_user_team_members_ai_user" ON "ai_user_team_members" USING btree ("ai_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_user_teams_name" ON "ai_user_teams" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_ai_users_enabled" ON "ai_users" USING btree ("enabled","name");--> statement-breakpoint
CREATE INDEX "idx_cas_conversation" ON "conversation_agent_sessions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_ai_users_conversation" ON "conversation_ai_users" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "idx_conversation_execution_lease_expiry" ON "conversation_execution_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_live_queue_run_sequence" ON "conversation_live_queue_items" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_live_queue_conversation_message" ON "conversation_live_queue_items" USING btree ("conversation_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_live_queue_conversation_state" ON "conversation_live_queue_items" USING btree ("conversation_id","state");--> statement-breakpoint
CREATE INDEX "idx_conversation_live_runs_status" ON "conversation_live_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_conversation_public_shares_token" ON "conversation_public_shares" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "idx_conversations_group_folder" ON "conversations" USING btree ("group_folder","created_at");--> statement-breakpoint
CREATE INDEX "idx_conversations_last_assistant_at" ON "conversations" USING btree ("last_assistant_at");--> statement-breakpoint
CREATE INDEX "idx_cronjobs_project" ON "cronjobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_cronjobs_next_run" ON "cronjobs" USING btree ("next_run");--> statement-breakpoint
CREATE INDEX "idx_dataset_tasks_project" ON "dataset_tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_device_keys_user" ON "device_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_device_pairings_expiry" ON "device_pairings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_push_tokens_user" ON "device_push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_external_issue_imports_task" ON "external_issue_imports" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_run_source_session_turn" ON "external_run_costs" USING btree ("source","external_session_id","external_turn_id");--> statement-breakpoint
CREATE INDEX "idx_external_run_started" ON "external_run_costs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_external_run_group" ON "external_run_costs" USING btree ("group_folder","started_at");--> statement-breakpoint
CREATE INDEX "idx_file_favorite_moves_project" ON "file_favorite_moves" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_favorites_group" ON "file_favorites" USING btree ("user_id","project_id","path") WHERE "file_favorites"."kind" = 'group';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_file_favorites_knowledge" ON "file_favorites" USING btree ("user_id","project_id","kb_id","filename") WHERE "file_favorites"."kind" = 'knowledge';--> statement-breakpoint
CREATE INDEX "idx_file_favorites_project_path" ON "file_favorites" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "idx_memories_group_folder" ON "memories" USING btree ("group_folder");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_audit_item_memory" ON "memory_audit_items" USING btree ("audit_id","memory_id");--> statement-breakpoint
CREATE INDEX "idx_memory_audit_items_audit_state" ON "memory_audit_items" USING btree ("audit_id","processing_state");--> statement-breakpoint
CREATE INDEX "idx_memory_audits_project_created" ON "memory_audits" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_audits_status" ON "memory_audits" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_audits_active_project" ON "memory_audits" USING btree ("project_id") WHERE "memory_audits"."status" IN ('queued', 'running', 'ready', 'applying', 'paused');--> statement-breakpoint
CREATE INDEX "idx_memory_certificates_memory" ON "memory_evidence_certificates" USING btree ("memory_id","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_memory_certificates_project" ON "memory_evidence_certificates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_memory_evidence_certificate" ON "memory_evidence_files" USING btree ("certificate_id");--> statement-breakpoint
CREATE INDEX "idx_memory_evidence_file_hash" ON "memory_evidence_files" USING btree ("file_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_history_apply_operation" ON "memory_history_apply_operations" USING btree ("manifest_id","operation_index");--> statement-breakpoint
CREATE INDEX "idx_memory_history_apply_project" ON "memory_history_apply_operations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_index_candidate_key" ON "memory_index_candidates" USING btree ("audit_id","candidate_key");--> statement-breakpoint
CREATE INDEX "idx_memory_index_candidates_audit" ON "memory_index_candidates" USING btree ("audit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_reflector_operation" ON "memory_reflector_operations" USING btree ("run_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_reflector_source" ON "memory_reflector_runs" USING btree ("project_id","transcript_path","transcript_fingerprint","byte_offset","profile","mode");--> statement-breakpoint
CREATE INDEX "idx_memory_reflector_project_status" ON "memory_reflector_runs" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_transcript_evidence" ON "memory_transcript_evidence" USING btree ("memory_id","source_ref","message_id","excerpt");--> statement-breakpoint
CREATE INDEX "idx_memory_transcript_evidence_memory" ON "memory_transcript_evidence" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX "idx_message_speech_assets_asset" ON "message_speech_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_notif_payloads_user_undelivered" ON "notification_payloads" USING btree ("user_id","delivered_at");--> statement-breakpoint
CREATE INDEX "idx_notif_payloads_expires" ON "notification_payloads" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notif_payloads_source_tool_use" ON "notification_payloads" USING btree ("user_id","source_tool_use_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_codes_expiry" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_requests_expiry" ON "oauth_authorization_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_created" ON "oauth_clients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_grants_user" ON "oauth_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_tokens_grant" ON "oauth_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_objective_task_event_holds_state_created" ON "objective_task_event_holds" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "idx_objective_task_event_holds_task_event" ON "objective_task_event_holds" USING btree ("task_id","event_type","state");--> statement-breakpoint
CREATE INDEX "idx_objectives_project" ON "objectives" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_objectives_status" ON "objectives" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_proposals_conversation" ON "proposals" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_proposals_project" ON "proposals" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_public_prompt_requests_conversation_created" ON "public_prompt_requests" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_public_prompt_requests_visitor_created" ON "public_prompt_requests" USING btree ("visitor_hash","created_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_next_run" ON "scheduled_tasks" USING btree ("next_run");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_status" ON "scheduled_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_group" ON "scheduled_tasks" USING btree ("group_folder");--> statement-breakpoint
CREATE INDEX "idx_stage_entry_events_project_state_created" ON "stage_entry_events" USING btree ("project_id","state","created_at");--> statement-breakpoint
CREATE INDEX "idx_stage_entry_events_task_stage_state" ON "stage_entry_events" USING btree ("task_id","stage_id","state");--> statement-breakpoint
CREATE INDEX "idx_stage_entry_events_run" ON "stage_entry_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_task_board_events_project_time" ON "task_board_events" USING btree ("project_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "idx_task_board_events_task_time" ON "task_board_events" USING btree ("task_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "idx_task_board_events_task_id_desc" ON "task_board_events" USING btree ("task_id","id" DESC NULLS LAST,"status");--> statement-breakpoint
CREATE INDEX "idx_task_board_events_completed_task_id_desc" ON "task_board_events" USING btree ("task_id","id" DESC NULLS LAST) WHERE "task_board_events"."status" = 'completed';--> statement-breakpoint
CREATE INDEX "idx_task_board_events_archived_task_id" ON "task_board_events" USING btree ("task_id","id") WHERE "task_board_events"."snapshot"->>'archived' = 'true';--> statement-breakpoint
CREATE INDEX "idx_task_messages_task_id" ON "task_messages" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_task_run_logs_task_id" ON "task_run_logs" USING btree ("task_id","run_at");--> statement-breakpoint
CREATE INDEX "idx_task_run_logs_run_id" ON "task_run_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_task_stage_comments_task" ON "task_stage_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_project" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tasks_project_status" ON "tasks" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "idx_tasks_ab_parent_task_id" ON "tasks" USING btree ("ab_parent_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tasks_ab_parent_variant" ON "tasks" USING btree ("ab_parent_task_id","stage_variant");--> statement-breakpoint
CREATE INDEX "idx_tts_audio_assets_last_accessed" ON "tts_audio_assets" USING btree ("last_accessed_at");--> statement-breakpoint
CREATE INDEX "idx_users_created_at" ON "users" USING btree ("created_at");