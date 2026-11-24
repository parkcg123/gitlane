package io.github.parkcg123.gitlane.ui

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import io.github.parkcg123.gitlane.config.FlowConfig
import io.github.parkcg123.gitlane.git.DiscoveredRepo
import io.github.parkcg123.gitlane.git.GitRunner
import io.github.parkcg123.gitlane.workflow.WorkflowEngine
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

class GitLaneConfigurable(private val project: Project) : Configurable {
    private var repos: List<DiscoveredRepo> = emptyList()
    private var repoCombo: ComboBox<DiscoveredRepo>? = null
    private val useDevelopCheck = JBCheckBox("스테이지(develop) 브랜치 사용 (2단계 모드)")
    private val developField = JBTextField()
    private val masterField = JBTextField()
    private val remoteField = JBTextField()
    private val separatorField = JBTextField()
    private val returnToDevelopCheck = JBCheckBox("운영(master) 반영 후 develop 브랜치로 자동 복귀")
    private val noFfCheck = JBCheckBox("병합 시 --no-ff 옵션으로 머지 커밋 이력 유지")
    private val detectStatusLabel = JLabel("")
    private var loadedConfig: FlowConfig = FlowConfig()

    override fun getDisplayName(): String = "GitLane"

    override fun createComponent(): JComponent {
        repos = IntelliJGitSupport.discoverReposFast(project)
        val activeRepo = IntelliJGitSupport.resolveActiveRepo(project, repos)

        val builder = FormBuilder.createFormBuilder()
        if (repos.size >= 2) {
            val combo = ComboBox(repos.toTypedArray())
            combo.renderer = javax.swing.DefaultListCellRenderer().also { renderer ->
                combo.setRenderer { list, value, index, isSelected, cellHasFocus ->
                    renderer.getListCellRendererComponent(
                        list,
                        value?.label ?: "",
                        index,
                        isSelected,
                        cellHasFocus,
                    )
                }
            }
            if (activeRepo != null) {
                combo.selectedItem = activeRepo
            }
            combo.addActionListener {
                val selected = combo.selectedItem as? DiscoveredRepo ?: return@addActionListener
                loadRepoIntoForm(selected)
            }
            repoCombo = combo
            builder.addLabeledComponent("대상 저장소:", combo)
        }

        val detectButton = JButton("브랜치 자동 감지")
        detectButton.addActionListener {
            val targetRepo = selectedRepo() ?: return@addActionListener
            var detected: FlowConfig? = null
            ProgressManager.getInstance().runProcessWithProgressSynchronously(
                {
                    val remote = remoteField.text.trim().ifEmpty { "origin" }
                    detected = WorkflowEngine.detectRecommendedConfig(GitRunner(targetRepo.root), remote)
                },
                "GitLane 브랜치 구조 감지 중...",
                false,
                project,
            )
            detected?.let { rec ->
                useDevelopCheck.isSelected = rec.useDevelopBranch
                developField.text = rec.developBranch
                masterField.text = rec.masterBranch
                developField.isEnabled = rec.useDevelopBranch
                returnToDevelopCheck.isEnabled = rec.useDevelopBranch
                detectStatusLabel.text = if (rec.useDevelopBranch) {
                    "감지 결과: 2단계 (${rec.developBranch} → ${rec.masterBranch})"
                } else {
                    "감지 결과: 운영 직행 (${rec.masterBranch} 바로 반영)"
                }
            }
        }

        useDevelopCheck.addActionListener {
            val enabled = useDevelopCheck.isSelected
            developField.isEnabled = enabled
            returnToDevelopCheck.isEnabled = enabled
        }

        val detectRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        detectRow.add(detectButton)
        detectRow.add(detectStatusLabel)

        builder
            .addComponent(useDevelopCheck)
            .addLabeledComponent("스테이지(develop) 브랜치:", developField)
            .addLabeledComponent("운영(master/main) 브랜치:", masterField)
            .addLabeledComponent("원격 저장소(remote):", remoteField)
            .addLabeledComponent("날짜-작업명 구분자:", separatorField)
            .addComponent(returnToDevelopCheck)
            .addComponent(noFfCheck)
            .addComponent(detectRow)
            .addComponentFillVertically(JPanel(), 0)

        (activeRepo ?: repos.firstOrNull())?.let { loadRepoIntoForm(it) }

        val wrapper = JPanel(BorderLayout())
        wrapper.add(builder.panel, BorderLayout.NORTH)
        return wrapper
    }

    private fun selectedRepo(): DiscoveredRepo? {
        return (repoCombo?.selectedItem as? DiscoveredRepo) ?: repos.firstOrNull()
    }

    private fun loadRepoIntoForm(repo: DiscoveredRepo) {
        loadedConfig = FlowConfig.loadFromRepo(repo.root)
        useDevelopCheck.isSelected = loadedConfig.useDevelopBranch
        developField.text = loadedConfig.developBranch
        masterField.text = loadedConfig.masterBranch
        remoteField.text = loadedConfig.remote
        separatorField.text = loadedConfig.separator
        returnToDevelopCheck.isSelected = loadedConfig.returnToDevelopAfterRelease
        noFfCheck.isSelected = loadedConfig.useNoFastForwardMerge
        developField.isEnabled = loadedConfig.useDevelopBranch
        returnToDevelopCheck.isEnabled = loadedConfig.useDevelopBranch
        detectStatusLabel.text = ""
    }

    private fun currentFormConfig(): FlowConfig {
        return FlowConfig(
            useDevelopBranch = useDevelopCheck.isSelected,
            developBranch = developField.text.trim().ifEmpty { loadedConfig.developBranch },
            masterBranch = masterField.text.trim().ifEmpty { loadedConfig.masterBranch },
            remote = remoteField.text.trim().ifEmpty { loadedConfig.remote },
            dateFormat = loadedConfig.dateFormat,
            separator = separatorField.text.trim().ifEmpty { loadedConfig.separator },
            returnToDevelopAfterRelease = returnToDevelopCheck.isSelected,
            useNoFastForwardMerge = noFfCheck.isSelected,
        )
    }

    override fun isModified(): Boolean {
        if (repos.isEmpty()) {
            return false
        }
        return currentFormConfig() != loadedConfig
    }

    override fun apply() {
        val targetRepo = selectedRepo() ?: return
        val nextConfig = currentFormConfig()
        FlowConfig.writeToRepo(targetRepo.root, nextConfig)
        loadedConfig = nextConfig
        IntelliJGitSupport.refreshIdeState(project, targetRepo.root)
    }

    override fun reset() {
        selectedRepo()?.let { loadRepoIntoForm(it) }
    }
}
