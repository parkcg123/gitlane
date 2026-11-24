package io.github.parkcg123.gitlane.ui

import com.intellij.openapi.components.Service
import java.nio.file.Path

@Service(Service.Level.PROJECT)
class RepoSelectionService {
    @Volatile
    var lastSelectedRepoRoot: Path? = null

    @Volatile
    var lastActiveEditorFile: Path? = null
}
