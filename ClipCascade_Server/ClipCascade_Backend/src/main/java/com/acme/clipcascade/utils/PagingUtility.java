package com.acme.clipcascade.utils;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import java.util.stream.Collectors;

import com.acme.clipcascade.model.PageResponse;

/**
 * Generic in-memory filter + sort + paginate for admin listings.
 * Used by services whose data isn't backed by Spring Data (online users,
 * BFA tracker, etc.) and for joined views that can't be paged at the DB
 * layer directly.
 *
 * Conventions:
 *  - size <= 0 means "return all rows on a single page".
 *  - "desc" (case-insensitive) reverses the comparator; anything else is ascending.
 *  - An unknown sort key falls back to no sort.
 */
public final class PagingUtility {

    private PagingUtility() {
    }

    public static <T> PageResponse<T> apply(
            List<T> items,
            Predicate<T> searchFilter,
            Map<String, Comparator<T>> comparators,
            String sortKey,
            String direction,
            int page,
            int size,
            String search) {

        List<T> filtered = (searchFilter == null)
                ? new ArrayList<>(items)
                : items.stream().filter(searchFilter).collect(Collectors.toList());

        Comparator<T> comparator = (comparators == null || sortKey == null)
                ? null
                : comparators.get(sortKey);
        if (comparator != null) {
            if ("desc".equalsIgnoreCase(direction)) {
                comparator = comparator.reversed();
            }
            filtered.sort(comparator);
        }

        long totalElements = filtered.size();
        List<T> content;
        int totalPages;
        int pageOut = page;

        if (size <= 0) {
            content = filtered;
            totalPages = 1;
            pageOut = 0;
        } else {
            totalPages = (int) Math.max(1, (long) Math.ceil((double) totalElements / size));
            if (pageOut < 0) {
                pageOut = 0;
            }
            if (pageOut > totalPages - 1) {
                pageOut = totalPages - 1;
            }
            int from = pageOut * size;
            int to = (int) Math.min((long) from + size, totalElements);
            content = (from >= filtered.size())
                    ? new ArrayList<>()
                    : new ArrayList<>(filtered.subList(from, to));
        }

        return new PageResponse<>(
                content,
                totalElements,
                totalPages,
                pageOut,
                size,
                sortKey,
                direction,
                search);
    }

    /**
     * Null-safe case-insensitive substring match. Returns false when haystack
     * is null and true when needle is empty (no-op filter).
     */
    public static boolean contains(String haystack, String needle) {
        if (needle == null || needle.isEmpty()) {
            return true;
        }
        if (haystack == null) {
            return false;
        }
        return haystack.toLowerCase().contains(needle);
    }
}
