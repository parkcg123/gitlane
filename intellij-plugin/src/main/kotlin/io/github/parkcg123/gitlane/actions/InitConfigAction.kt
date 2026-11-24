package io.github.parkcg123.gitlane.actions

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import io.github.parkcg123.gitlane.config.FlowConfig
import io.github.parkcg123.gitlane.git.GitRunner
import io.github.parkcg123.gitlane.ui.IntelliJGitSupport
import io.github.parkcg123.gitlane.workflow.WorkflowEngine
import java.nio.file.Files
import java.nio.file.Path

class InitConfigAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val repos = IntelliJGitSupport.discoverReposFast(project)
        val activeRepo = IntelliJGitSupport.resolveActiveRepo(project, repos)
        if (activeRepo == null) {
            IntelliJGitSupport.notify(
                project,
                "열려 있는 Git 저장소를 찾을 수 없습니다. 프로젝트 폴더를 열어 주세요.",
                NotificationType.WARNING,
            )
            return
        }
        val repoLabel = if (repos.size >= 2) activeRepo.label else null
        runForRepo(project, activeRepo.root, repoLabel)
    }

    companion object {
        fun runForRepo(project: Project, repoRoot: Path, repoLabel: String?) {
            val configPath = repoRoot.resolve(FlowConfig.CONFIG_FILENAME)
            if (Files.isRegularFile(configPath)) {
                openConfigInEditor(project, configPath)
                return
            }

            val title = if (repoLabel != null) {
                "GitLane [$repoLabel]: 브랜치 구조 감지"
            } else {
                "GitLane: 브랜치 구조 감지"
            }

            ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, false) {
                override fun run(indicator: ProgressIndicator) {
                    val detected = WorkflowEngine.detectRecommendedConfig(GitRunner(repoRoot))
                    ApplicationManager.getApplication().invokeLater {
                        if (project.isDisposed) {
                            return@invokeLater
                        }
                        val detectedDesc = if (detected.useDevelopBranch) {
                            "2단계 (${detected.developBranch} → ${detected.masterBranch})"
                        } else {
                            "운영 직행 (${detected.masterBranch} 바로 반영)"
                        }
                        val dialogTitle = if (repoLabel != null) {
                            "GitLane [$repoLabel] — 설정 (.gitlane.json)"
                        } else {
                            "GitLane — 설정 (.gitlane.json)"
                        }
                        val choiceIndex = Messages.showDialog(
                            project,
                            "${FlowConfig.CONFIG_FILENAME} 파일이 없습니다.\n자동 감지 추천: $detectedDesc\n\n생성할 워크플로우 모드를 선택하세요.",
                            dialogTitle,
                            arrayOf(
                                "자동 감지 추천으로 생성",
                                "2단계 모드 (${detected.developBranch} → ${detected.masterBranch})",
                                "운영 직행 모드 (${detected.masterBranch} 바로 반영)",
                                "취소",
                            ),
                            0,
                            Messages.getQuestionIcon(),
                        )
                        val chosen = when (choiceIndex) {
                            0 -> detected
                            1 -> detected.copy(useDevelopBranch = true)
                            2 -> detected.copy(useDevelopBranch = false)
                            else -> null
                        } ?: return@invokeLater

                        val writtenPath = FlowConfig.writeToRepo(repoRoot, chosen)
                        openConfigInEditor(project, writtenPath)
                        IntelliJGitSupport.refreshIdeState(project, repoRoot)
                        IntelliJGitSupport.notify(
                            project,
                            "${FlowConfig.CONFIG_FILENAME} 설정 파일을 생성했습니다.",
                            NotificationType.INFORMATION,
                            repoLabel,
                        )
                    }
                }
            })
        }

        private fun openConfigInEditor(project: Project, configPath: Path) {
            val vf = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(configPath) ?: return
            vf.refresh(false, false)
            FileEditorManager.getInstance(project).openFile(vf, true)
        }
    }
}
