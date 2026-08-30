use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const HARNESS_CONTRACT_VERSION: &str = "1.0";
const DEFAULT_TASK_TTL_SECONDS: u64 = 3_600;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessExecutionMode {
    Sandbox,
    Hybrid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessTaskState {
    Created,
    Queued,
    Reserved,
    Preparing,
    Running,
    Validating,
    AwaitingApproval,
    RetryPending,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Expired,
}

impl HarnessTaskState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Expired
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessAttemptState {
    Reserved,
    Preparing,
    Running,
    Validating,
    Succeeded,
    Failed,
    Cancelled,
    Expired,
}

impl HarnessAttemptState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Expired
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessVerificationLevel {
    Verified,
    PartiallyVerified,
    Unverified,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HarnessApprovalScope {
    ExecuteUat,
    ApplyPatch,
    Merge,
    DeployUat,
    DeployProduction,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessBudgets {
    pub max_wall_time_ms: u64,
    pub max_cpu_time_ms: u64,
    pub max_memory_mb: u32,
    pub max_disk_mb: u32,
    pub max_output_bytes: u64,
    pub max_tool_calls: u32,
    pub max_model_turns: u32,
    pub max_repair_attempts: u32,
}

impl Default for HarnessBudgets {
    fn default() -> Self {
        Self {
            max_wall_time_ms: 900_000,
            max_cpu_time_ms: 600_000,
            max_memory_mb: 8_192,
            max_disk_mb: 4_096,
            max_output_bytes: 1_048_576,
            max_tool_calls: 80,
            max_model_turns: 24,
            max_repair_attempts: 2,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessTask {
    pub task_id: String,
    pub harness_contract_version: String,
    pub tenant_id: String,
    pub repository_source_id: String,
    pub base_revision: String,
    pub allowed_path_prefixes: Vec<String>,
    pub execution_mode: HarnessExecutionMode,
    pub allowed_operations: Vec<String>,
    pub validation_profiles: Vec<String>,
    pub budgets: HarnessBudgets,
    pub state: HarnessTaskState,
    pub state_version: u64,
    pub current_attempt_id: Option<String>,
    pub verification_level: Option<HarnessVerificationLevel>,
    pub terminal_code: Option<String>,
    pub created_at_epoch: u64,
    pub updated_at_epoch: u64,
    pub expires_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessAttempt {
    pub attempt_id: String,
    pub task_id: String,
    pub node_id: String,
    pub execution_mode: HarnessExecutionMode,
    pub state: HarnessAttemptState,
    pub state_version: u64,
    pub reserved_slots: u32,
    pub workspace_id: Option<String>,
    pub failure_code: Option<String>,
    pub created_at_epoch: u64,
    pub updated_at_epoch: u64,
    pub started_at_epoch: Option<u64>,
    pub finished_at_epoch: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessCapacityReservation {
    pub reservation_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub node_id: String,
    pub slots: u32,
    pub state: String,
    pub created_at_epoch: u64,
    pub expires_at_epoch: u64,
    pub released_at_epoch: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessApproval {
    pub approval_id: String,
    pub task_id: String,
    pub artifact_digest: Option<String>,
    pub target: String,
    pub scope: HarnessApprovalScope,
    pub approver: String,
    pub created_at_epoch: u64,
    pub expires_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessAuditEvent {
    pub event_id: String,
    pub task_id: String,
    pub attempt_id: Option<String>,
    pub actor: String,
    pub event_type: String,
    pub code: Option<String>,
    pub metadata: serde_json::Value,
    pub created_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CreateHarnessTaskRequest {
    #[serde(default = "default_contract_version")]
    pub harness_contract_version: String,
    pub tenant_id: String,
    pub repository_source_id: String,
    pub base_revision: String,
    #[serde(default)]
    pub allowed_path_prefixes: Vec<String>,
    pub execution_mode: HarnessExecutionMode,
    #[serde(default)]
    pub allowed_operations: Vec<String>,
    #[serde(default)]
    pub validation_profiles: Vec<String>,
    #[serde(default)]
    pub budgets: HarnessBudgets,
    #[serde(default)]
    pub expires_at_epoch: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CreateHarnessApprovalRequest {
    pub scope: HarnessApprovalScope,
    pub target: String,
    pub approver: String,
    #[serde(default)]
    pub artifact_digest: Option<String>,
    pub expires_at_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessTransitionRequest {
    pub expected_state_version: u64,
    pub state: HarnessTaskState,
    #[serde(default)]
    pub verification_level: Option<HarnessVerificationLevel>,
    #[serde(default)]
    pub code: Option<String>,
    pub actor: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReserveHarnessAttemptRequest {
    pub expected_task_state_version: u64,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default = "default_true")]
    pub allow_sandbox_fallback: bool,
    #[serde(default = "default_reserved_slots")]
    pub slots: u32,
    #[serde(default = "default_reservation_ttl_seconds")]
    pub reservation_ttl_seconds: u64,
    pub actor: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessAttemptTransitionRequest {
    pub expected_state_version: u64,
    pub state: HarnessAttemptState,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    pub actor: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HarnessReconciliation {
    pub task_id: String,
    pub attempt_id: String,
    pub expected_task_state_version: u64,
    pub expected_attempt_state_version: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HarnessState {
    #[serde(default)]
    pub tasks: BTreeMap<String, HarnessTask>,
    #[serde(default)]
    pub attempts: BTreeMap<String, HarnessAttempt>,
    #[serde(default)]
    pub reservations: BTreeMap<String, HarnessCapacityReservation>,
    #[serde(default)]
    pub approvals: BTreeMap<String, HarnessApproval>,
    #[serde(default)]
    pub audit_events: Vec<HarnessAuditEvent>,
}

impl HarnessState {
    pub fn reconcile_unavailable_nodes(
        &mut self,
        unavailable_node_ids: &[String],
        now_epoch: u64,
    ) -> Vec<HarnessReconciliation> {
        let candidates = self
            .attempts
            .values()
            .filter(|attempt| {
                !attempt.state.is_terminal() && unavailable_node_ids.contains(&attempt.node_id)
            })
            .map(|attempt| {
                let task_version = self
                    .tasks
                    .get(&attempt.task_id)
                    .map(|task| task.state_version)
                    .unwrap_or_default();
                (
                    attempt.attempt_id.clone(),
                    attempt.task_id.clone(),
                    task_version,
                    attempt.state_version,
                )
            })
            .collect::<Vec<_>>();
        let mut reconciled = Vec::new();
        for (attempt_id, task_id, task_version, attempt_version) in candidates {
            let cancelling = self
                .tasks
                .get(&task_id)
                .is_some_and(|task| task.state == HarnessTaskState::Cancelling);
            let next = if cancelling {
                HarnessAttemptState::Cancelled
            } else {
                HarnessAttemptState::Expired
            };
            if self
                .transition_attempt(
                    &attempt_id,
                    attempt_version,
                    next,
                    None,
                    Some(
                        if cancelling {
                            "HARNESS_CANCELLED"
                        } else {
                            "HARNESS_NODE_LOST"
                        }
                        .to_string(),
                    ),
                    "maintenance",
                    now_epoch,
                )
                .is_ok()
            {
                let attempts_used = self
                    .attempts
                    .values()
                    .filter(|attempt| attempt.task_id == task_id)
                    .count() as u32;
                if !cancelling {
                    if let Some(task) = self.tasks.get(&task_id).cloned() {
                        if attempts_used > task.budgets.max_repair_attempts {
                            let _ = self.transition_task(
                                &task_id,
                                task.state_version,
                                HarnessTaskState::Failed,
                                None,
                                Some("HARNESS_RETRY_EXHAUSTED".to_string()),
                                "maintenance",
                                now_epoch,
                            );
                        }
                    }
                }
                reconciled.push(HarnessReconciliation {
                    task_id,
                    attempt_id,
                    expected_task_state_version: task_version,
                    expected_attempt_state_version: attempt_version,
                });
            }
        }
        reconciled
    }

    pub fn record_routing_decision(
        &mut self,
        task_id: &str,
        attempt_id: Option<&str>,
        actor: &str,
        decision: serde_json::Value,
        now_epoch: u64,
    ) -> Result<(), HarnessError> {
        if !self.tasks.contains_key(task_id) {
            return Err(HarnessError::new(
                "HARNESS_TASK_NOT_FOUND",
                "harness task does not exist",
            ));
        }
        self.audit(
            task_id,
            attempt_id,
            actor,
            "harness_routing_decision",
            None,
            decision,
            now_epoch,
        );
        Ok(())
    }

    pub fn create_task(
        &mut self,
        request: CreateHarnessTaskRequest,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessTask, HarnessError> {
        validate_create_request(&request, now_epoch)?;
        let task_id = format!("htask_{}", Uuid::new_v4().simple());
        let task = HarnessTask {
            task_id: task_id.clone(),
            harness_contract_version: request.harness_contract_version,
            tenant_id: request.tenant_id.trim().to_string(),
            repository_source_id: request.repository_source_id.trim().to_string(),
            base_revision: request.base_revision.to_ascii_lowercase(),
            allowed_path_prefixes: normalized_list(request.allowed_path_prefixes),
            execution_mode: request.execution_mode,
            allowed_operations: normalized_list(request.allowed_operations),
            validation_profiles: normalized_list(request.validation_profiles),
            budgets: request.budgets,
            state: HarnessTaskState::Created,
            state_version: 1,
            current_attempt_id: None,
            verification_level: None,
            terminal_code: None,
            created_at_epoch: now_epoch,
            updated_at_epoch: now_epoch,
            expires_at_epoch: request
                .expires_at_epoch
                .unwrap_or(now_epoch.saturating_add(DEFAULT_TASK_TTL_SECONDS)),
        };
        self.tasks.insert(task_id.clone(), task.clone());
        self.audit(
            &task_id,
            None,
            actor,
            "harness_task_created",
            None,
            serde_json::json!({
                "execution_mode": task.execution_mode,
                "repository_source_id": task.repository_source_id,
                "base_revision": task.base_revision,
            }),
            now_epoch,
        );
        Ok(task)
    }

    pub fn add_approval(
        &mut self,
        task_id: &str,
        request: CreateHarnessApprovalRequest,
        now_epoch: u64,
    ) -> Result<HarnessApproval, HarnessError> {
        let task = self.tasks.get(task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if task.state.is_terminal() || request.expires_at_epoch <= now_epoch {
            return Err(HarnessError::new(
                "HARNESS_APPROVAL_REQUIRED",
                "approval is expired or the task is terminal",
            ));
        }
        validate_identifier(&request.approver, "approver")?;
        validate_identifier(&request.target, "approval target")?;
        if request.scope != HarnessApprovalScope::ExecuteUat
            && request
                .artifact_digest
                .as_deref()
                .is_none_or(|value| !is_sha256(value))
        {
            return Err(HarnessError::new(
                "HARNESS_ARTIFACT_INVALID",
                "non-execution approval requires an exact artifact SHA-256",
            ));
        }
        let approval = HarnessApproval {
            approval_id: format!("happroval_{}", Uuid::new_v4().simple()),
            task_id: task_id.to_string(),
            artifact_digest: request
                .artifact_digest
                .map(|value| value.to_ascii_lowercase()),
            target: request.target,
            scope: request.scope,
            approver: request.approver,
            created_at_epoch: now_epoch,
            expires_at_epoch: request.expires_at_epoch,
        };
        self.approvals
            .insert(approval.approval_id.clone(), approval.clone());
        if approval.scope == HarnessApprovalScope::ExecuteUat {
            self.transition_task(
                task_id,
                self.tasks[task_id].state_version,
                HarnessTaskState::Queued,
                None,
                None,
                &approval.approver,
                now_epoch,
            )?;
        }
        self.audit(
            task_id,
            None,
            &approval.approver,
            "harness_approval_recorded",
            None,
            serde_json::json!({
                "approval_id": approval.approval_id,
                "scope": approval.scope,
                "target": approval.target,
                "artifact_digest": approval.artifact_digest,
            }),
            now_epoch,
        );
        Ok(approval)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reserve_attempt(
        &mut self,
        task_id: &str,
        expected_task_state_version: u64,
        node_id: &str,
        execution_mode: HarnessExecutionMode,
        slots: u32,
        node_total_slots: u32,
        reservation_ttl_seconds: u64,
        actor: &str,
        now_epoch: u64,
    ) -> Result<(HarnessAttempt, HarnessCapacityReservation), HarnessError> {
        validate_identifier(node_id, "node id")?;
        if slots == 0
            || slots > node_total_slots
            || reservation_ttl_seconds == 0
            || reservation_ttl_seconds > 3_600
        {
            return Err(HarnessError::new(
                "HARNESS_RESOURCE_EXHAUSTED",
                "reservation slots or TTL are invalid for this node",
            ));
        }
        let task = self.tasks.get(task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if task.state != HarnessTaskState::Queued
            || task.state_version != expected_task_state_version
        {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "only the current queued task version can be reserved",
            ));
        }
        let approved = self.approvals.values().any(|approval| {
            approval.task_id == task_id
                && approval.scope == HarnessApprovalScope::ExecuteUat
                && approval.expires_at_epoch > now_epoch
        });
        if !approved {
            return Err(HarnessError::new(
                "HARNESS_APPROVAL_REQUIRED",
                "an unexpired execute_uat approval is required",
            ));
        }
        let active_slots = self
            .reservations
            .values()
            .filter(|reservation| {
                reservation.node_id == node_id
                    && reservation.state == "active"
                    && reservation.expires_at_epoch > now_epoch
            })
            .map(|reservation| reservation.slots)
            .sum::<u32>();
        if active_slots.saturating_add(slots) > node_total_slots {
            return Err(HarnessError::new(
                "HARNESS_RESOURCE_EXHAUSTED",
                "node does not have enough unreserved harness slots",
            ));
        }
        let attempt_id = format!("hattempt_{}", Uuid::new_v4().simple());
        let reservation = HarnessCapacityReservation {
            reservation_id: format!("hreservation_{}", Uuid::new_v4().simple()),
            task_id: task_id.to_string(),
            attempt_id: attempt_id.clone(),
            node_id: node_id.to_string(),
            slots,
            state: "active".to_string(),
            created_at_epoch: now_epoch,
            expires_at_epoch: now_epoch.saturating_add(reservation_ttl_seconds),
            released_at_epoch: None,
        };
        let attempt = HarnessAttempt {
            attempt_id: attempt_id.clone(),
            task_id: task_id.to_string(),
            node_id: node_id.to_string(),
            execution_mode,
            state: HarnessAttemptState::Reserved,
            state_version: 1,
            reserved_slots: slots,
            workspace_id: None,
            failure_code: None,
            created_at_epoch: now_epoch,
            updated_at_epoch: now_epoch,
            started_at_epoch: None,
            finished_at_epoch: None,
        };
        self.attempts.insert(attempt_id.clone(), attempt.clone());
        self.reservations
            .insert(reservation.reservation_id.clone(), reservation.clone());
        let task = self.tasks.get_mut(task_id).expect("validated harness task");
        task.state = HarnessTaskState::Reserved;
        task.state_version = task.state_version.saturating_add(1);
        task.current_attempt_id = Some(attempt_id.clone());
        task.updated_at_epoch = now_epoch;
        self.audit(
            task_id,
            Some(&attempt_id),
            actor,
            "harness_capacity_reserved",
            None,
            serde_json::json!({
                "reservation_id": reservation.reservation_id,
                "node_id": node_id,
                "execution_mode": execution_mode,
                "slots": slots,
                "capacity_before": node_total_slots.saturating_sub(active_slots),
                "capacity_after": node_total_slots.saturating_sub(active_slots.saturating_add(slots)),
            }),
            now_epoch,
        );
        Ok((attempt, reservation))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transition_attempt(
        &mut self,
        attempt_id: &str,
        expected_state_version: u64,
        next: HarnessAttemptState,
        workspace_id: Option<String>,
        code: Option<String>,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessAttempt, HarnessError> {
        let attempt = self.attempts.get_mut(attempt_id).ok_or_else(|| {
            HarnessError::new(
                "HARNESS_ATTEMPT_NOT_FOUND",
                "harness attempt does not exist",
            )
        })?;
        if attempt.state_version != expected_state_version {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "harness attempt state version changed",
            ));
        }
        if attempt.state == next {
            return Ok(attempt.clone());
        }
        if !valid_attempt_transition(attempt.state, next) {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                format!(
                    "invalid harness attempt transition {:?} -> {:?}",
                    attempt.state, next
                ),
            ));
        }
        if next == HarnessAttemptState::Preparing {
            let value = workspace_id.as_deref().unwrap_or_default();
            validate_identifier(value, "workspace id")?;
            attempt.workspace_id = workspace_id;
        }
        attempt.state = next;
        attempt.state_version = attempt.state_version.saturating_add(1);
        attempt.updated_at_epoch = now_epoch;
        if next == HarnessAttemptState::Running && attempt.started_at_epoch.is_none() {
            attempt.started_at_epoch = Some(now_epoch);
        }
        if next.is_terminal() {
            attempt.finished_at_epoch = Some(now_epoch);
            attempt.failure_code = code.clone();
        }
        let result = attempt.clone();
        let task_id = result.task_id.clone();
        if let Some(task) = self.tasks.get_mut(&task_id) {
            let task_state = match next {
                HarnessAttemptState::Reserved => HarnessTaskState::Reserved,
                HarnessAttemptState::Preparing => HarnessTaskState::Preparing,
                HarnessAttemptState::Running => HarnessTaskState::Running,
                HarnessAttemptState::Validating => HarnessTaskState::Validating,
                HarnessAttemptState::Succeeded => HarnessTaskState::AwaitingApproval,
                HarnessAttemptState::Failed => HarnessTaskState::RetryPending,
                HarnessAttemptState::Cancelled => HarnessTaskState::Cancelled,
                HarnessAttemptState::Expired => HarnessTaskState::RetryPending,
            };
            if task.state != task_state {
                task.state = task_state;
                task.state_version = task.state_version.saturating_add(1);
                task.updated_at_epoch = now_epoch;
            }
        }
        if next.is_terminal() {
            for reservation in self.reservations.values_mut().filter(|reservation| {
                reservation.attempt_id == attempt_id && reservation.state == "active"
            }) {
                reservation.state = "released".to_string();
                reservation.released_at_epoch = Some(now_epoch);
            }
        }
        self.audit(
            &task_id,
            Some(attempt_id),
            actor,
            "harness_attempt_transitioned",
            code.as_deref(),
            serde_json::json!({
                "state": result.state,
                "state_version": result.state_version,
                "workspace_id": result.workspace_id,
            }),
            now_epoch,
        );
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transition_task(
        &mut self,
        task_id: &str,
        expected_state_version: u64,
        next: HarnessTaskState,
        verification_level: Option<HarnessVerificationLevel>,
        code: Option<String>,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessTask, HarnessError> {
        let task = self.tasks.get_mut(task_id).ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if task.state_version != expected_state_version {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "harness task state version changed",
            ));
        }
        if task.state == next {
            return Ok(task.clone());
        }
        if !valid_task_transition(task.state, next) {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                format!("invalid harness transition {:?} -> {:?}", task.state, next),
            ));
        }
        if next == HarnessTaskState::Completed && verification_level.is_none() {
            return Err(HarnessError::new(
                "HARNESS_VALIDATION_FAILED",
                "completed task requires an explicit verification level",
            ));
        }
        task.state = next;
        task.state_version = task.state_version.saturating_add(1);
        task.updated_at_epoch = now_epoch;
        if next.is_terminal() {
            task.verification_level = verification_level;
            task.terminal_code = code.clone();
        }
        let result = task.clone();
        self.audit(
            task_id,
            result.current_attempt_id.as_deref(),
            actor,
            "harness_task_transitioned",
            code.as_deref(),
            serde_json::json!({
                "state": result.state,
                "state_version": result.state_version,
                "verification_level": result.verification_level,
            }),
            now_epoch,
        );
        Ok(result)
    }

    pub fn cancel_task(
        &mut self,
        task_id: &str,
        actor: &str,
        now_epoch: u64,
    ) -> Result<HarnessTask, HarnessError> {
        let task = self.tasks.get(task_id).cloned().ok_or_else(|| {
            HarnessError::new("HARNESS_TASK_NOT_FOUND", "harness task does not exist")
        })?;
        if task.state == HarnessTaskState::Cancelled {
            return Ok(task);
        }
        if task.state.is_terminal() {
            return Err(HarnessError::new(
                "HARNESS_STATE_CONFLICT",
                "terminal harness task cannot be cancelled",
            ));
        }
        let next = if matches!(
            task.state,
            HarnessTaskState::Created | HarnessTaskState::Queued
        ) {
            HarnessTaskState::Cancelled
        } else {
            HarnessTaskState::Cancelling
        };
        self.transition_task(
            task_id,
            task.state_version,
            next,
            None,
            Some("HARNESS_CANCELLED".to_string()),
            actor,
            now_epoch,
        )
    }

    pub fn expire_tasks(&mut self, now_epoch: u64) -> Vec<HarnessTask> {
        let candidates = self
            .tasks
            .values()
            .filter(|task| !task.state.is_terminal() && task.expires_at_epoch <= now_epoch)
            .map(|task| (task.task_id.clone(), task.current_attempt_id.clone()))
            .collect::<Vec<_>>();
        let mut expired = Vec::new();
        for (task_id, attempt_id) in candidates {
            if let Some(attempt_id) = attempt_id {
                if let Some(attempt) = self.attempts.get(&attempt_id).cloned() {
                    if !attempt.state.is_terminal() {
                        let _ = self.transition_attempt(
                            &attempt_id,
                            attempt.state_version,
                            HarnessAttemptState::Expired,
                            None,
                            Some("HARNESS_TIMEOUT".to_string()),
                            "maintenance",
                            now_epoch,
                        );
                    }
                }
            }
            let version = self.tasks[&task_id].state_version;
            if let Ok(task) = self.transition_task(
                &task_id,
                version,
                HarnessTaskState::Expired,
                None,
                Some("HARNESS_TIMEOUT".to_string()),
                "maintenance",
                now_epoch,
            ) {
                expired.push(task);
            }
        }
        expired
    }

    #[allow(clippy::too_many_arguments)]
    fn audit(
        &mut self,
        task_id: &str,
        attempt_id: Option<&str>,
        actor: &str,
        event_type: &str,
        code: Option<&str>,
        metadata: serde_json::Value,
        now_epoch: u64,
    ) {
        self.audit_events.push(HarnessAuditEvent {
            event_id: format!("haudit_{}", Uuid::new_v4().simple()),
            task_id: task_id.to_string(),
            attempt_id: attempt_id.map(str::to_string),
            actor: actor.to_string(),
            event_type: event_type.to_string(),
            code: code.map(str::to_string),
            metadata,
            created_at_epoch: now_epoch,
        });
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct HarnessError {
    pub code: String,
    pub message: String,
}

impl HarnessError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

fn default_contract_version() -> String {
    HARNESS_CONTRACT_VERSION.to_string()
}

fn default_reserved_slots() -> u32 {
    1
}

fn default_reservation_ttl_seconds() -> u64 {
    900
}

fn default_true() -> bool {
    true
}

fn validate_create_request(
    request: &CreateHarnessTaskRequest,
    now_epoch: u64,
) -> Result<(), HarnessError> {
    if request.harness_contract_version != HARNESS_CONTRACT_VERSION {
        return Err(HarnessError::new(
            "HARNESS_VERSION_UNSUPPORTED",
            "only Coding Harness contract 1.0 is supported",
        ));
    }
    validate_identifier(&request.tenant_id, "tenant id")?;
    validate_identifier(&request.repository_source_id, "repository source id")?;
    if request.base_revision.len() != 40
        || !request
            .base_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(HarnessError::new(
            "HARNESS_BASE_REVISION_INVALID",
            "base revision must be a full 40-character Git commit id",
        ));
    }
    if request
        .expires_at_epoch
        .is_some_and(|expires| expires <= now_epoch)
        || request.budgets.max_wall_time_ms == 0
        || request.budgets.max_cpu_time_ms == 0
        || request.budgets.max_cpu_time_ms > request.budgets.max_wall_time_ms
        || request.budgets.max_memory_mb == 0
        || request.budgets.max_disk_mb == 0
        || request.budgets.max_output_bytes == 0
        || request.budgets.max_tool_calls == 0
        || request.budgets.max_model_turns == 0
    {
        return Err(HarnessError::new(
            "HARNESS_POLICY_DENIED",
            "harness expiration or budgets are invalid",
        ));
    }
    for path in &request.allowed_path_prefixes {
        if path.trim().is_empty()
            || path.starts_with('/')
            || path.contains("..")
            || path.contains('\\')
        {
            return Err(HarnessError::new(
                "HARNESS_PATH_DENIED",
                "allowed path prefixes must be normalized relative paths",
            ));
        }
    }
    let allowed = [
        "repository.status",
        "repository.diff",
        "file.read",
        "file.search",
        "patch.apply",
        "validation.run",
        "artifact.publish",
    ];
    if request.allowed_operations.is_empty()
        || request
            .allowed_operations
            .iter()
            .any(|operation| !allowed.contains(&operation.as_str()))
    {
        return Err(HarnessError::new(
            "HARNESS_OPERATION_UNSUPPORTED",
            "task contains an unknown or empty operation set",
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), HarnessError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 160
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
    {
        return Err(HarnessError::new(
            "HARNESS_POLICY_DENIED",
            format!("{label} is invalid"),
        ));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn normalized_list(mut values: Vec<String>) -> Vec<String> {
    for value in &mut values {
        *value = value.trim().to_string();
    }
    values.sort();
    values.dedup();
    values
}

fn valid_task_transition(from: HarnessTaskState, to: HarnessTaskState) -> bool {
    use HarnessTaskState::*;
    matches!(
        (from, to),
        (Created, Queued | Cancelled | Expired)
            | (Queued, Reserved | Cancelled | Expired)
            | (
                Reserved,
                Preparing | Cancelling | RetryPending | Failed | Expired
            )
            | (
                Preparing,
                Running | Cancelling | RetryPending | Failed | Expired
            )
            | (
                Running,
                Validating | Cancelling | RetryPending | Failed | Expired
            )
            | (
                Validating,
                AwaitingApproval | Completed | Cancelling | RetryPending | Failed | Expired
            )
            | (AwaitingApproval, Completed | Cancelling | Failed | Expired)
            | (RetryPending, Queued | Cancelling | Failed | Expired)
            | (Cancelling, Cancelled | Failed)
    )
}

fn valid_attempt_transition(from: HarnessAttemptState, to: HarnessAttemptState) -> bool {
    use HarnessAttemptState::*;
    matches!(
        (from, to),
        (Reserved, Preparing | Failed | Cancelled | Expired)
            | (Preparing, Running | Failed | Cancelled | Expired)
            | (Running, Validating | Failed | Cancelled | Expired)
            | (Validating, Succeeded | Failed | Cancelled | Expired)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> CreateHarnessTaskRequest {
        CreateHarnessTaskRequest {
            harness_contract_version: HARNESS_CONTRACT_VERSION.to_string(),
            tenant_id: "tenant-1".to_string(),
            repository_source_id: "repo-1".to_string(),
            base_revision: "a".repeat(40),
            allowed_path_prefixes: vec!["src".to_string(), "tests".to_string()],
            execution_mode: HarnessExecutionMode::Sandbox,
            allowed_operations: vec!["file.read".to_string(), "validation.run".to_string()],
            validation_profiles: vec!["rust-default".to_string()],
            budgets: HarnessBudgets::default(),
            expires_at_epoch: Some(2_000),
        }
    }

    #[test]
    fn task_requires_independent_execute_approval_before_queueing() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        assert_eq!(task.state, HarnessTaskState::Created);
        let approval = state
            .add_approval(
                &task.task_id,
                CreateHarnessApprovalRequest {
                    scope: HarnessApprovalScope::ExecuteUat,
                    target: "uat".to_string(),
                    approver: "operator".to_string(),
                    artifact_digest: None,
                    expires_at_epoch: 1_500,
                },
                1_001,
            )
            .unwrap();
        assert_eq!(approval.scope, HarnessApprovalScope::ExecuteUat);
        assert_eq!(state.tasks[&task.task_id].state, HarnessTaskState::Queued);
    }

    #[test]
    fn optimistic_state_transitions_reject_stale_and_invalid_updates() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        state
            .add_approval(
                &task.task_id,
                CreateHarnessApprovalRequest {
                    scope: HarnessApprovalScope::ExecuteUat,
                    target: "uat".to_string(),
                    approver: "operator".to_string(),
                    artifact_digest: None,
                    expires_at_epoch: 1_500,
                },
                1_001,
            )
            .unwrap();
        let queued = state.tasks[&task.task_id].clone();
        assert_eq!(
            state
                .transition_task(
                    &task.task_id,
                    queued.state_version - 1,
                    HarnessTaskState::Reserved,
                    None,
                    None,
                    "scheduler",
                    1_002,
                )
                .unwrap_err()
                .code,
            "HARNESS_STATE_CONFLICT"
        );
        assert_eq!(
            state
                .transition_task(
                    &task.task_id,
                    queued.state_version,
                    HarnessTaskState::Completed,
                    Some(HarnessVerificationLevel::Verified),
                    None,
                    "scheduler",
                    1_002,
                )
                .unwrap_err()
                .code,
            "HARNESS_STATE_CONFLICT"
        );
    }

    #[test]
    fn cancellation_is_idempotent_and_expiry_is_terminal() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        let cancelled = state.cancel_task(&task.task_id, "operator", 1_001).unwrap();
        assert_eq!(cancelled.state, HarnessTaskState::Cancelled);
        assert_eq!(
            state
                .cancel_task(&task.task_id, "operator", 1_002)
                .unwrap()
                .state_version,
            cancelled.state_version
        );

        let mut expiring = request();
        expiring.expires_at_epoch = Some(1_010);
        let expiring = state.create_task(expiring, "operator", 1_000).unwrap();
        let expired = state.expire_tasks(1_010);
        assert_eq!(expired.len(), 1);
        assert_eq!(
            state.tasks[&expiring.task_id].state,
            HarnessTaskState::Expired
        );
    }

    fn approve_for_execution(state: &mut HarnessState, task_id: &str) {
        state
            .add_approval(
                task_id,
                CreateHarnessApprovalRequest {
                    scope: HarnessApprovalScope::ExecuteUat,
                    target: "uat".to_string(),
                    approver: "operator".to_string(),
                    artifact_digest: None,
                    expires_at_epoch: 1_900,
                },
                1_001,
            )
            .unwrap();
    }

    #[test]
    fn reservations_never_oversubscribe_node_slots() {
        let mut state = HarnessState::default();
        let first = state.create_task(request(), "operator", 1_000).unwrap();
        let second = state.create_task(request(), "operator", 1_000).unwrap();
        approve_for_execution(&mut state, &first.task_id);
        approve_for_execution(&mut state, &second.task_id);
        state
            .reserve_attempt(
                &first.task_id,
                state.tasks[&first.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                2,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        assert_eq!(
            state
                .reserve_attempt(
                    &second.task_id,
                    state.tasks[&second.task_id].state_version,
                    "node-1",
                    HarnessExecutionMode::Sandbox,
                    1,
                    2,
                    300,
                    "scheduler",
                    1_002,
                )
                .unwrap_err()
                .code,
            "HARNESS_RESOURCE_EXHAUSTED"
        );
    }

    #[test]
    fn successful_attempt_releases_capacity_and_awaits_artifact_approval() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        approve_for_execution(&mut state, &task.task_id);
        let (mut attempt, reservation) = state
            .reserve_attempt(
                &task.task_id,
                state.tasks[&task.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                1,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        for (next, workspace) in [
            (
                HarnessAttemptState::Preparing,
                Some("workspace-1".to_string()),
            ),
            (HarnessAttemptState::Running, None),
            (HarnessAttemptState::Validating, None),
            (HarnessAttemptState::Succeeded, None),
        ] {
            attempt = state
                .transition_attempt(
                    &attempt.attempt_id,
                    attempt.state_version,
                    next,
                    workspace,
                    None,
                    "node-1",
                    1_003 + attempt.state_version,
                )
                .unwrap();
        }
        assert_eq!(
            state.tasks[&task.task_id].state,
            HarnessTaskState::AwaitingApproval
        );
        assert_eq!(
            state.reservations[&reservation.reservation_id].state,
            "released"
        );
        assert!(attempt.finished_at_epoch.is_some());
    }

    #[test]
    fn task_expiry_terminates_attempt_and_releases_reservation() {
        let mut state = HarnessState::default();
        let mut expiring_request = request();
        expiring_request.expires_at_epoch = Some(1_010);
        let task = state
            .create_task(expiring_request, "operator", 1_000)
            .unwrap();
        approve_for_execution(&mut state, &task.task_id);
        let (attempt, reservation) = state
            .reserve_attempt(
                &task.task_id,
                state.tasks[&task.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                1,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        state.expire_tasks(1_010);
        assert_eq!(state.tasks[&task.task_id].state, HarnessTaskState::Expired);
        assert_eq!(
            state.attempts[&attempt.attempt_id].state,
            HarnessAttemptState::Expired
        );
        assert_eq!(
            state.reservations[&reservation.reservation_id].state,
            "released"
        );
    }

    #[test]
    fn node_loss_reconciles_attempt_and_capacity_without_replaying_side_effects() {
        let mut state = HarnessState::default();
        let task = state.create_task(request(), "operator", 1_000).unwrap();
        approve_for_execution(&mut state, &task.task_id);
        let (attempt, reservation) = state
            .reserve_attempt(
                &task.task_id,
                state.tasks[&task.task_id].state_version,
                "node-1",
                HarnessExecutionMode::Sandbox,
                1,
                2,
                300,
                "scheduler",
                1_002,
            )
            .unwrap();
        let reconciled = state.reconcile_unavailable_nodes(&["node-1".to_string()], 1_010);
        assert_eq!(reconciled.len(), 1);
        assert_eq!(
            state.attempts[&attempt.attempt_id].state,
            HarnessAttemptState::Expired
        );
        assert_eq!(
            state.tasks[&task.task_id].state,
            HarnessTaskState::RetryPending
        );
        assert_eq!(
            state.reservations[&reservation.reservation_id].state,
            "released"
        );
    }
}
