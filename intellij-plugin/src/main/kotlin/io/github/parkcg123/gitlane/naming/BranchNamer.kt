package io.github.parkcg123.gitlane.naming

import io.github.parkcg123.gitlane.config.FlowConfig
import java.time.LocalDate
import java.time.format.DateTimeFormatter

object BranchNamer {
    private val DATE_FORMATTER: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd")
    private val FORBIDDEN_CHARS_REGEX = Regex("""[~^:?*\[\\]""")

    /**
     * Uses local calendar date (never UTC) so branch names match the user's current date.
     */
    fun formatLocalDate(date: LocalDate = LocalDate.now()): String {
        return date.format(DATE_FORMATTER)
    }

    fun sanitizeTaskName(raw: String, separator: String = "_"): String {
        val sep = separator.ifEmpty { "_" }
        val escapedSep = Regex.escape(sep)
        return raw.trim()
            .replace(Regex("""\s+"""), sep)
            .replace(Regex("""(?:$escapedSep){2,}"""), sep)
            .replace(Regex("""^(?:$escapedSep)+|(?:$escapedSep)+$"""), "")
    }

    fun validateTaskName(raw: String, separator: String = "_"): String? {
        val sanitized = sanitizeTaskName(raw, separator)
        if (sanitized.isEmpty()) {
            return "작업명을 입력해 주세요."
        }

        if (sanitized.any { it.code < 32 || it.code == 127 }) {
            return "제어 문자는 브랜치 이름에 사용할 수 없습니다."
        }

        if (
            sanitized.contains('/') ||
            sanitized.contains("..") ||
            sanitized.contains("@{") ||
            FORBIDDEN_CHARS_REGEX.containsMatchIn(sanitized)
        ) {
            return "브랜치 이름에 사용할 수 없는 문자(/, .., @{, ~, ^, :, ?, *, [, \\)가 포함되어 있습니다."
        }

        if (sanitized.startsWith('.') || sanitized.endsWith('.')) {
            return "브랜치 이름은 마침표(.)로 시작하거나 끝날 수 없습니다."
        }

        if (sanitized.lowercase().endsWith(".lock")) {
            return "브랜치 이름은 .lock으로 끝날 수 없습니다."
        }

        return null
    }

    fun buildTaskBranchName(
        raw: String,
        config: FlowConfig = FlowConfig(),
        date: LocalDate = LocalDate.now(),
    ): String {
        val sep = config.separator.ifEmpty { "_" }
        val error = validateTaskName(raw, sep)
        require(error == null) { error ?: "유효하지 않은 작업명입니다." }
        val sanitized = sanitizeTaskName(raw, sep)
        return "${formatLocalDate(date)}$sep$sanitized"
    }

    fun isProtectedBranch(branch: String, config: FlowConfig): Boolean {
        return branch == config.developBranch || branch == config.masterBranch
    }
}
