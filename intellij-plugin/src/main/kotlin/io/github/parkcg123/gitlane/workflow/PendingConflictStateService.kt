package io.github.parkcg123.gitlane.workflow

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import java.nio.file.Path

@Service(Service.Level.PROJECT)
@State(
    name = "GitLanePendingConflict",
    storages = [Storage(StoragePathMacros.WORKSPACE_FILE)],
)
class PendingConflictStateService : PersistentStateComponent<PendingConflictStateService.State> {
    data class StoredConflict(
        var targetBranch: String = "",
        var sourceBranch: String = "",
        var returnBranch: String = "",
        var deleteSourceOnComplete: Boolean = false,
        var kind: String = "",
        var remainingTargets: MutableList<String> = mutableListOf(),
    )

    data class State(
        var conflictsByRepo: MutableMap<String, StoredConflict> = LinkedHashMap(),
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    fun get(repoRoot: Path): PendingConflictContext? {
        val stored = state.conflictsByRepo[keyFor(repoRoot)] ?: return null
        if (stored.targetBranch.isEmpty() || stored.sourceBranch.isEmpty()) {
            return null
        }
        return PendingConflictContext(
            targetBranch = stored.targetBranch,
            sourceBranch = stored.sourceBranch,
            returnBranch = stored.returnBranch,
            deleteSourceOnComplete = stored.deleteSourceOnComplete,
            kind = stored.kind,
            remainingTargets = stored.remainingTargets.toList(),
        )
    }

    fun set(repoRoot: Path, context: PendingConflictContext?) {
        val key = keyFor(repoRoot)
        if (context == null) {
            state.conflictsByRepo.remove(key)
            return
        }
        state.conflictsByRepo[key] = StoredConflict(
            targetBranch = context.targetBranch,
            sourceBranch = context.sourceBranch,
            returnBranch = context.returnBranch,
            deleteSourceOnComplete = context.deleteSourceOnComplete,
            kind = context.kind,
            remainingTargets = context.remainingTargets.toMutableList(),
        )
    }

    private fun keyFor(repoRoot: Path): String = repoRoot.toAbsolutePath().normalize().toString()
}
