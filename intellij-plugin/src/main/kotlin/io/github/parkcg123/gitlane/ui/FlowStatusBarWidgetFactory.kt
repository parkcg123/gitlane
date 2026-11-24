package io.github.parkcg123.gitlane.ui

import com.intellij.ide.DataManager
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.WindowManager
import com.intellij.ui.awt.RelativePoint
import com.intellij.util.Consumer
import git4idea.repo.GitRepository
import git4idea.repo.GitRepositoryChangeListener
import io.github.parkcg123.gitlane.config.FlowConfig
import io.github.parkcg123.gitlane.git.DiscoveredRepo
import java.awt.Component
import java.awt.event.MouseEvent

class FlowStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = WIDGET_ID

    override fun getDisplayName(): String = "GitLane"

    override fun isAvailable(project: Project): Boolean = project.basePath != null

    override fun createWidget(project: Project): StatusBarWidget = FlowStatusBarWidget(project)

    companion object {
        const val WIDGET_ID = "io.github.parkcg123.gitlane.StatusBarWidget"

        fun refreshWidget(project: Project) {
            if (project.isDisposed) {
                return
            }
            val widget = WindowManager.getInstance()
                .getStatusBar(project)
                ?.getWidget(WIDGET_ID) as? FlowStatusBarWidget
            widget?.refreshAsync()
        }
    }
}

private class FlowStatusBarWidget(private val project: Project) :
    StatusBarWidget, StatusBarWidget.TextPresentation {

    private var statusBar: StatusBar? = null

    @Volatile
    private var cachedText: String = "GitLane"

    @Volatile
    private var cachedTooltip: String = "클릭하여 GitLane 워크플로우 메뉴 열기"

    private data class RepoSnapshot(
        val repo: DiscoveredRepo,
        val merging: Boolean,
        val branch: String?,
        val config: FlowConfig,
    )

    override fun ID(): String = FlowStatusBarWidgetFactory.WIDGET_ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        val connection = project.messageBus.connect(this)
        connection.subscribe(
            GitRepository.GIT_REPO_CHANGE,
            GitRepositoryChangeListener { refreshAsync() },
        )
        connection.subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    val file = event.newFile
                    val localPath = if (file == null) {
                        null
                    } else if (file.isInLocalFileSystem) {
                        runCatching { file.toNioPath() }.getOrNull()
                    } else {
                        return
                    }
                    IntelliJGitSupport.rememberActiveEditorFile(project, localPath)
                    refreshAsync()
                }
            },
        )
        refreshAsync()
    }

    override fun dispose() {
        statusBar = null
    }

    fun refreshAsync() {
        if (project.isDisposed) {
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            if (project.isDisposed) {
                return@executeOnPooledThread
            }
            val (nextText, nextTooltip) = computeDisplayState()
            cachedText = nextText
            cachedTooltip = nextTooltip
            ApplicationManager.getApplication().invokeLater({
                if (!project.isDisposed) {
                    statusBar?.updateWidget(ID())
                }
            }, ModalityState.any())
        }
    }

    private fun summarizeShortBranch(snap: RepoSnapshot): String {
        return when {
            snap.merging -> "머지 충돌 중"
            snap.branch == null -> "HEAD 분리됨"
            snap.branch == snap.config.masterBranch -> "${snap.branch} (운영)"
            snap.config.useDevelopBranch && snap.branch == snap.config.developBranch -> "${snap.branch} (스테이지)"
            else -> snap.branch
        }
    }

    private fun computeDisplayState(): Pair<String, String> {
        val repos = IntelliJGitSupport.discoverReposFast(project)
        if (repos.isEmpty()) {
            return "GitLane" to "Git 저장소를 찾을 수 없습니다."
        }
        return try {
            val snapshots = repos.map { repo ->
                RepoSnapshot(
                    repo = repo,
                    merging = IntelliJGitSupport.isMergeInProgressFast(project, repo.root),
                    branch = IntelliJGitSupport.getCurrentBranchFast(project, repo.root),
                    config = IntelliJGitSupport.resolveQuickConfig(project, repo.root),
                )
            }
            val activeRepo = IntelliJGitSupport.resolveActiveRepo(project, repos)
            val active = snapshots.firstOrNull { it.repo.root == activeRepo?.root } ?: snapshots.first()

            if (snapshots.size == 1) {
                return when {
                    active.merging ->
                        "GitLane: 머지 충돌 중" to "클릭하여 충돌 해결 또는 머지 취소를 선택하세요."
                    active.branch == null ->
                        "GitLane: HEAD 분리됨" to "Detached HEAD 상태입니다. 브랜치를 확인해 주세요."
                    active.branch == active.config.masterBranch -> {
                        val tooltip = if (active.config.useDevelopBranch) {
                            "운영 브랜치(${active.branch}) — 클릭하여 GitLane 메뉴 열기"
                        } else {
                            "운영 브랜치(${active.branch}) — 클릭하여 작업 시작 또는 GitLane 메뉴 열기"
                        }
                        "GitLane: ${active.branch} (운영)" to tooltip
                    }
                    active.config.useDevelopBranch && active.branch == active.config.developBranch ->
                        "GitLane: ${active.branch} (스테이지)" to "스테이지 브랜치(${active.branch}) — 클릭하여 작업 시작 또는 운영 반영 실행"
                    else -> {
                        val tooltip = if (active.config.useDevelopBranch) {
                            "작업 브랜치(${active.branch}) — 클릭하여 작업 반영 또는 메뉴 열기"
                        } else {
                            "작업 브랜치(${active.branch}) — 클릭하여 ${active.config.masterBranch} 바로 병합 또는 메뉴 열기"
                        }
                        "GitLane: ${active.branch}" to tooltip
                    }
                }
            }

            val otherCount = snapshots.size - 1
            val tooltip = buildString {
                append("GitLane — 저장소 ${snapshots.size}개 (클릭하여 저장소별 메뉴 열기)")
                for (snap in snapshots) {
                    val currentMarker = if (snap.repo.root == active.repo.root) " (현재)" else ""
                    append("\n• ${snap.repo.label}: ${summarizeShortBranch(snap)}$currentMarker")
                }
            }

            val mergingRepos = snapshots.filter { it.merging }
            val text = when {
                mergingRepos.size == 1 ->
                    "GitLane [${mergingRepos.first().repo.label}]: 머지 충돌 중 (+$otherCount)"
                mergingRepos.size > 1 ->
                    "GitLane: 머지 충돌 ${mergingRepos.size}곳 (+${snapshots.size - mergingRepos.size})"
                else ->
                    "GitLane [${active.repo.label}]: ${summarizeShortBranch(active)} (+$otherCount)"
            }
            text to tooltip
        } catch (_: Exception) {
            "GitLane" to "클릭하여 GitLane 워크플로우 메뉴 열기"
        }
    }

    override fun getText(): String = cachedText

    override fun getAlignment(): Float = Component.LEFT_ALIGNMENT

    override fun getTooltipText(): String = cachedTooltip

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { event ->
        val actionGroup = ActionManager.getInstance().getAction("GitLane.ActionGroup") as? ActionGroup
            ?: return@Consumer
        val repos = IntelliJGitSupport.discoverReposFast(project)
        val popupTitle = if (repos.size >= 2) "GitLane (${repos.size}개 저장소)" else "GitLane"
        val popup = JBPopupFactory.getInstance().createActionGroupPopup(
            popupTitle,
            actionGroup,
            DataManager.getInstance().getDataContext(event.component),
            JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
            true,
        )
        popup.show(RelativePoint(event))
    }
}
