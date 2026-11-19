package io.github.parkcg123.gitlane.ui

import com.intellij.ide.DataManager
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
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
import io.github.parkcg123.gitlane.git.GitRunner
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

    override fun ID(): String = FlowStatusBarWidgetFactory.WIDGET_ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        project.messageBus.connect(this).subscribe(
            GitRepository.GIT_REPO_CHANGE,
            GitRepositoryChangeListener { refreshAsync() },
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

    private fun computeDisplayState(): Pair<String, String> {
        val repoRoot = IntelliJGitSupport.resolveRepoRoot(project)
            ?: return "GitLane" to "Git 저장소를 찾을 수 없습니다."
        return try {
            val git = GitRunner(repoRoot)
            val config = FlowConfig.loadFromRepo(repoRoot)
            when {
                git.isMergeInProgress() ->
                    "GitLane: 머지 충돌 중" to "클릭하여 충돌 해결 또는 머지 취소를 선택하세요."
                else -> {
                    val branch = git.getCurrentBranch()
                        ?: return "GitLane: HEAD 분리됨" to "Detached HEAD 상태입니다. 브랜치를 확인해 주세요."
                    when (branch) {
                        config.masterBranch ->
                            "GitLane: $branch (운영)" to "운영 브랜치($branch) — 클릭하여 GitLane 메뉴 열기"
                        config.developBranch ->
                            "GitLane: $branch (스테이지)" to "스테이지 브랜치($branch) — 클릭하여 작업 시작 또는 운영 반영 실행"
                        else ->
                            "GitLane: $branch" to "작업 브랜치($branch) — 클릭하여 스테이지 반영 또는 메뉴 열기"
                    }
                }
            }
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
        val popup = JBPopupFactory.getInstance().createActionGroupPopup(
            "GitLane",
            actionGroup,
            DataManager.getInstance().getDataContext(event.component),
            JBPopupFactory.ActionSelectionAid.SPEEDSEARCH,
            true,
        )
        popup.show(RelativePoint(event))
    }
}
