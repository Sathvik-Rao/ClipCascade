package com.acme.ClipCascade.controller;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.SendTo;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ResponseBody;

import com.acme.ClipCascade.model.ClipText;

@Controller
public class ClipCascadeController {
    @Value("${CC_MAX_MESSAGE_SIZE}")
    private int MAX_MESSAGE_SIZE_IN_MiB;

    @MessageMapping("/cliptext")
    @SendTo("/topic/cliptext")
    public ClipText broadcast(ClipText text) {
        return new ClipText(text.getText());
    }

    @GetMapping("/max-size")
    @ResponseBody
    public String getMaxSizeAllowed() {
        int MAX_MESSAGE_SIZE = (MAX_MESSAGE_SIZE_IN_MiB << 20); // bytes

        return "{\"maxsize\": " + MAX_MESSAGE_SIZE + "}";
    }
}
