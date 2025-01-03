package com.acme.clipcascade.utils;

import java.util.function.Supplier;

import org.springframework.http.ResponseEntity;

public class ResponseEntityUtil {
    public static ResponseEntity<String> buildResponse(boolean condition, String successMessage, String errorMessage) {
        return condition ? ResponseEntity.ok(successMessage) : ResponseEntity.badRequest().body(errorMessage);
    }

    @SuppressWarnings("unchecked")
    public static <T> ResponseEntity<T> executeWithResponse(Supplier<T> action) {
        try {
            return ResponseEntity.ok(action.get());
        } catch (Exception e) {
            return ResponseEntity.badRequest().body((T) e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    public static <T> ResponseEntity<T> conditionalExecuteOrError(boolean condition,
            Supplier<ResponseEntity<T>> successAction,
            String errorMessage) {

        return condition
                ? successAction.get()
                : ResponseEntity.badRequest().body((T) errorMessage);
    }
}
