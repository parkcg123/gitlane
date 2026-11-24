package io.github.parkcg123.gitlane.git

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.name

data class DiscoveredRepo(
    val root: Path,
    val label: String,
)

object RepoDiscovery {
    private val IGNORED_SCAN_DIRS = setOf(
        ".git",
        "node_modules",
        "build",
        "dist",
        "out",
        "out-test",
        "target",
        ".gradle",
        ".idea",
        ".vscode",
        ".next",
        "vendor",
        ".venv",
        "venv",
        "__pycache__",
    )

    fun normalizePath(targetPath: Path): Path {
        return runCatching { targetPath.toRealPath() }
            .getOrElse { targetPath.toAbsolutePath().normalize() }
    }

    fun hasGitMarker(dirPath: Path): Boolean {
        return runCatching { Files.exists(dirPath.resolve(".git")) }.getOrDefault(false)
    }

    fun findGitRootForPath(startPath: Path): Path? {
        var current: Path? = runCatching {
            val abs = startPath.toAbsolutePath().normalize()
            if (Files.isDirectory(abs)) abs else abs.parent
        }.getOrNull()

        var depth = 0
        while (current != null && depth < 64) {
            if (hasGitMarker(current)) {
                return normalizePath(current)
            }
            current = current.parent
            depth++
        }
        return null
    }

    fun scanNestedGitRepos(baseDir: Path, maxDepth: Int = 2): List<Path> {
        if (!Files.isDirectory(baseDir)) {
            return emptyList()
        }
        val normalizedBase = normalizePath(baseDir)
        val found = LinkedHashSet<Path>()

        findGitRootForPath(normalizedBase)?.let { found.add(it) }

        fun walk(dir: Path, depth: Int) {
            if (depth >= maxDepth) {
                return
            }
            val children = runCatching {
                Files.list(dir).use { stream -> stream.toList() }
            }.getOrDefault(emptyList())

            for (child in children) {
                if (Files.isSymbolicLink(child) || !Files.isDirectory(child)) {
                    continue
                }
                val folderName = child.fileName?.toString().orEmpty()
                if (folderName.isEmpty() || folderName.startsWith(".") || IGNORED_SCAN_DIRS.contains(folderName)) {
                    continue
                }
                if (hasGitMarker(child)) {
                    found.add(normalizePath(child))
                }
                walk(child, depth + 1)
            }
        }

        walk(normalizedBase, 0)
        return found.toList()
    }

    private fun relativeLabelFromWorkspaces(
        repoRoot: Path,
        normalizedWorkspaces: List<Path>,
    ): String? {
        for (ws in normalizedWorkspaces) {
            if (repoRoot == ws) {
                return repoRoot.fileName?.toString()?.takeIf { it.isNotEmpty() } ?: repoRoot.toString()
            }
            if (repoRoot.startsWith(ws)) {
                val rel = ws.relativize(repoRoot).toString().replace('\\', '/')
                if (rel.isNotEmpty()) {
                    return rel
                }
            }
        }
        return null
    }

    private fun tailSegments(targetPath: Path, count: Int): String {
        val countTotal = targetPath.nameCount
        if (countTotal <= 0) {
            return targetPath.toString()
        }
        val start = (countTotal - count).coerceAtLeast(0)
        return (start until countTotal).joinToString("/") { idx -> targetPath.getName(idx).toString() }
    }

    fun buildRepoLabels(
        roots: Collection<Path>,
        workspaceRoots: Collection<Path> = emptyList(),
    ): List<DiscoveredRepo> {
        val uniqueRoots = LinkedHashSet<Path>()
        for (root in roots) {
            if (Files.isDirectory(root)) {
                uniqueRoots.add(normalizePath(root))
            }
        }

        val normalizedWorkspaces = workspaceRoots
            .map { normalizePath(it) }
            .sortedByDescending { it.toString().length }

        val rootList = uniqueRoots.toList()
        val labels = LinkedHashMap<Path, String>(rootList.size)
        for (root in rootList) {
            labels[root] = root.name.ifEmpty { root.toString() }
        }

        val collisions = rootList.groupBy { labels.getValue(it) }
        for (group in collisions.values) {
            if (group.size <= 1) {
                continue
            }
            val relCandidates = group.associateWith { relativeLabelFromWorkspaces(it, normalizedWorkspaces) }
            val distinctRels = relCandidates.values.filterNotNull().toSet()
            if (relCandidates.values.none { it == null } && distinctRels.size == group.size) {
                for ((repoRoot, rel) in relCandidates) {
                    labels[repoRoot] = rel!!
                }
                continue
            }

            var depth = 2
            var remaining = group
            while (remaining.size > 1 && depth <= 8) {
                val nextGroups = LinkedHashMap<String, MutableList<Path>>()
                for (repoRoot in remaining) {
                    val candidate = tailSegments(repoRoot, depth)
                    labels[repoRoot] = candidate
                    nextGroups.getOrPut(candidate) { mutableListOf() }.add(repoRoot)
                }
                remaining = nextGroups.values.filter { it.size > 1 }.flatten()
                depth++
            }
            for (repoRoot in remaining) {
                labels[repoRoot] = repoRoot.toString()
            }
        }

        return rootList
            .map { DiscoveredRepo(it, labels.getValue(it)) }
            .sortedWith(compareBy<DiscoveredRepo> { it.label }.thenBy { it.root.toString() })
    }

    fun findContainingRepo(filePath: Path?, repos: List<DiscoveredRepo>): DiscoveredRepo? {
        if (filePath == null || repos.isEmpty()) {
            return null
        }
        val normalizedFile = normalizePath(filePath)
        var bestMatch: DiscoveredRepo? = null
        var bestLength = -1
        for (repo in repos) {
            if (normalizedFile.startsWith(repo.root)) {
                val rootLen = repo.root.toString().length
                if (rootLen > bestLength) {
                    bestLength = rootLen
                    bestMatch = repo
                }
            }
        }
        return bestMatch
    }
}
