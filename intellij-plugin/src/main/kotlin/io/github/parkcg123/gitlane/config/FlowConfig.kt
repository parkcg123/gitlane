package io.github.parkcg123.gitlane.config

import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

data class FlowConfig(
    val useDevelopBranch: Boolean = true,
    val developBranch: String = "develop",
    val masterBranch: String = "master",
    val remote: String = "origin",
    val dateFormat: String = "YYYYMMDD",
    val separator: String = "_",
    val returnToDevelopAfterRelease: Boolean = true,
    val useNoFastForwardMerge: Boolean = true,
) {
    fun taskBaseBranch(): String = if (useDevelopBranch) developBranch else masterBranch

    companion object {
        const val CONFIG_FILENAME = ".gitlane.json"

        fun loadFromRepo(repoRoot: Path): FlowConfig = loadWithWarning(repoRoot).config

        fun loadWithWarning(repoRoot: Path): LoadedFlowConfig {
            val configPath = repoRoot.resolve(CONFIG_FILENAME)
            if (!Files.isRegularFile(configPath)) {
                return LoadedFlowConfig(FlowConfig())
            }

            return try {
                val raw = Files.readString(configPath, StandardCharsets.UTF_8)
                val parsed = SimpleJsonParser(raw).parseTopLevelValue()
                if (parsed !is Map<*, *>) {
                    return LoadedFlowConfig(
                        config = FlowConfig(),
                        warning = "$CONFIG_FILENAME 형식이 올바른 JSON 객체가 아닙니다. 기본 설정을 사용합니다.",
                    )
                }
                LoadedFlowConfig(config = mergeFromMap(FlowConfig(), parsed))
            } catch (e: Exception) {
                val detail = e.message ?: e::class.java.simpleName
                LoadedFlowConfig(
                    config = FlowConfig(),
                    warning = "$CONFIG_FILENAME 파일을 읽는 중 오류가 발생했습니다 ($detail). 기본 설정을 사용합니다.",
                )
            }
        }

        private fun mergeFromMap(base: FlowConfig, map: Map<*, *>): FlowConfig {
            fun nonEmptyString(key: String): String? {
                val value = map[key] as? String ?: return null
                return value.trim().takeIf { it.isNotEmpty() }
            }

            fun booleanOrNull(key: String): Boolean? = map[key] as? Boolean

            return FlowConfig(
                useDevelopBranch = booleanOrNull("useDevelopBranch") ?: base.useDevelopBranch,
                developBranch = nonEmptyString("developBranch") ?: base.developBranch,
                masterBranch = nonEmptyString("masterBranch") ?: base.masterBranch,
                remote = nonEmptyString("remote") ?: base.remote,
                dateFormat = if (map["dateFormat"] == "YYYYMMDD") "YYYYMMDD" else base.dateFormat,
                separator = nonEmptyString("separator") ?: base.separator,
                returnToDevelopAfterRelease = booleanOrNull("returnToDevelopAfterRelease")
                    ?: base.returnToDevelopAfterRelease,
                useNoFastForwardMerge = booleanOrNull("useNoFastForwardMerge")
                    ?: base.useNoFastForwardMerge,
            )
        }
    }
}

data class LoadedFlowConfig(
    val config: FlowConfig,
    val warning: String? = null,
)

private class SimpleJsonParser(private val input: String) {
    private var index = 0

    fun parseTopLevelValue(): Any? {
        skipWhitespace()
        if (index >= input.length) {
            throw IllegalArgumentException("빈 JSON 파일입니다.")
        }
        val value = parseValue()
        skipWhitespace()
        if (index < input.length) {
            throw IllegalArgumentException("예상치 못한 문자 '${input[index]}' (위치 $index)")
        }
        return value
    }

    private fun parseValue(): Any? {
        skipWhitespace()
        if (index >= input.length) {
            throw IllegalArgumentException("예기치 않은 입력 종료")
        }
        return when (val ch = input[index]) {
            '{' -> parseObject()
            '[' -> parseArray()
            '"' -> parseString()
            't' -> parseLiteral("true", true)
            'f' -> parseLiteral("false", false)
            'n' -> parseLiteral("null", null)
            '-', in '0'..'9' -> parseNumber()
            else -> throw IllegalArgumentException("유효하지 않은 JSON 토큰 '$ch' (위치 $index)")
        }
    }

    private fun parseObject(): Map<String, Any?> {
        expect('{')
        val result = LinkedHashMap<String, Any?>()
        skipWhitespace()
        if (peek() == '}') {
            index++
            return result
        }
        while (true) {
            skipWhitespace()
            if (peek() != '"') {
                throw IllegalArgumentException("JSON 객체 키가 필요합니다 (위치 $index)")
            }
            val key = parseString()
            skipWhitespace()
            expect(':')
            val value = parseValue()
            result[key] = value
            skipWhitespace()
            when (peek()) {
                ',' -> index++
                '}' -> {
                    index++
                    return result
                }
                else -> throw IllegalArgumentException("',' 또는 '}'가 필요합니다 (위치 $index)")
            }
        }
    }

    private fun parseArray(): List<Any?> {
        expect('[')
        val result = ArrayList<Any?>()
        skipWhitespace()
        if (peek() == ']') {
            index++
            return result
        }
        while (true) {
            result.add(parseValue())
            skipWhitespace()
            when (peek()) {
                ',' -> index++
                ']' -> {
                    index++
                    return result
                }
                else -> throw IllegalArgumentException("',' 또는 ']'가 필요합니다 (위치 $index)")
            }
        }
    }

    private fun parseString(): String {
        expect('"')
        val sb = StringBuilder()
        while (index < input.length) {
            val ch = input[index++]
            when (ch) {
                '"' -> return sb.toString()
                '\\' -> {
                    if (index >= input.length) {
                        throw IllegalArgumentException("문자열 이스케이프가 완료되지 않았습니다.")
                    }
                    when (val esc = input[index++]) {
                        '"', '\\', '/' -> sb.append(esc)
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (index + 4 > input.length) {
                                throw IllegalArgumentException("유니코드 이스케이프 길이가 부족합니다.")
                            }
                            val hex = input.substring(index, index + 4)
                            val code = hex.toIntOrNull(16)
                                ?: throw IllegalArgumentException("유효하지 않은 유니코드 이스케이프 \\u$hex")
                            sb.append(code.toChar())
                            index += 4
                        }
                        else -> throw IllegalArgumentException("알 수 없는 이스케이프 \\$esc")
                    }
                }
                else -> {
                    if (ch.code < 0x20) {
                        throw IllegalArgumentException("문자열 내부에 제어 문자가 포함되어 있습니다.")
                    }
                    sb.append(ch)
                }
            }
        }
        throw IllegalArgumentException("닫히지 않은 문자열입니다.")
    }

    private fun parseLiteral(literal: String, value: Any?): Any? {
        if (!input.startsWith(literal, index)) {
            throw IllegalArgumentException("잘못된 리터럴 (위치 $index)")
        }
        index += literal.length
        return value
    }

    private fun parseNumber(): Number {
        val start = index
        if (peek() == '-') index++
        if (index >= input.length || input[index] !in '0'..'9') {
            throw IllegalArgumentException("유효하지 않은 숫자 (위치 $start)")
        }
        if (input[index] == '0') {
            index++
        } else {
            while (index < input.length && input[index] in '0'..'9') index++
        }
        var isFloat = false
        if (index < input.length && input[index] == '.') {
            isFloat = true
            index++
            if (index >= input.length || input[index] !in '0'..'9') {
                throw IllegalArgumentException("유효하지 않은 소수점 숫자 (위치 $start)")
            }
            while (index < input.length && input[index] in '0'..'9') index++
        }
        if (index < input.length && (input[index] == 'e' || input[index] == 'E')) {
            isFloat = true
            index++
            if (index < input.length && (input[index] == '+' || input[index] == '-')) index++
            if (index >= input.length || input[index] !in '0'..'9') {
                throw IllegalArgumentException("유효하지 않은 지수 숫자 (위치 $start)")
            }
            while (index < input.length && input[index] in '0'..'9') index++
        }
        val raw = input.substring(start, index)
        return if (isFloat) raw.toDouble() else raw.toLongOrNull() ?: raw.toDouble()
    }

    private fun skipWhitespace() {
        while (index < input.length && input[index] in charArrayOf(' ', '\t', '\r', '\n')) {
            index++
        }
    }

    private fun peek(): Char? = if (index < input.length) input[index] else null

    private fun expect(expected: Char) {
        if (index >= input.length || input[index] != expected) {
            throw IllegalArgumentException("'$expected' 문자가 필요합니다 (위치 $index)")
        }
        index++
    }
}
