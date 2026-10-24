package com.acme.clipcascade.service;

import java.awt.Color;
import java.awt.Font;
import java.awt.GraphicsEnvironment;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Random;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import com.acme.clipcascade.config.ClipCascadeProperties;

import cn.apiclub.captcha.Captcha;
import cn.apiclub.captcha.text.producer.DefaultTextProducer;
import cn.apiclub.captcha.text.renderer.DefaultWordRenderer;
import cn.apiclub.captcha.backgrounds.*;
import cn.apiclub.captcha.noise.*;
import cn.apiclub.captcha.gimpy.*;

import jakarta.servlet.http.HttpSession;

@Service
public class CaptchaService {

    private final Random RANDOM;
    private final List<Font> FONTS;
    private final List<Color> COLORS;
    private final char[] SRC_CHARS;
    private final List<BackgroundProducer> BACKGROUNDS;
    private final List<NoiseProducer> NOISES;
    private final List<GimpyRenderer> GIMPYS;
    private final int DIFFICULTY_PERCENT;

    public CaptchaService(@Autowired ClipCascadeProperties clipCascadeProperties) {

        // This service is used only when signup is enabled
        if (clipCascadeProperties.isSignupEnabled()) {
            RANDOM = new Random();
            FONTS = fonts();
            COLORS = colors();
            SRC_CHARS = generateCharArray();
            BACKGROUNDS = bgProds();
            NOISES = noiseProds();
            GIMPYS = gimpyRends();
            DIFFICULTY_PERCENT = clipCascadeProperties.getCaptchaDifficultyPercent();
        } else {
            RANDOM = null;
            FONTS = null;
            COLORS = null;
            SRC_CHARS = null;
            BACKGROUNDS = null;
            NOISES = null;
            GIMPYS = null;
            DIFFICULTY_PERCENT = 100;
        }
    }

    public BufferedImage generateCaptcha(
            int width,
            int height,
            int minSizeOfCaptcha,
            int maxSizeOfCaptcha,
            HttpSession session,
            String captchaSessionId,
            boolean caseSensitive) {

        // Create captcha
        Captcha captcha = createCaptcha(
                width,
                height,
                RANDOM.nextInt(maxSizeOfCaptcha - minSizeOfCaptcha + 1) + minSizeOfCaptcha);

        // Get the answer
        String answer = caseSensitive ? captcha.getAnswer() : captcha.getAnswer().toLowerCase();

        // Store the answer in the session to validate later
        session.setAttribute(captchaSessionId, answer);

        // Return the image
        return getCaptchaImage(captcha);
    }

    public boolean validateCaptcha(String input, boolean caseSensitive, HttpSession session, String captchaSessionId) {
        String captchaAnswer = (String) session.getAttribute(captchaSessionId);
        session.removeAttribute(captchaSessionId);

        if (!caseSensitive) {
            input = input.toLowerCase();
        }

        if (captchaAnswer != null && captchaAnswer.equals(input)) {
            return true;
        } else {
            return false;
        }
    }

    public Captcha createCaptcha(int width, int height, int sizeOfCaptcha) {
        return createCaptcha(width, height, sizeOfCaptcha, DIFFICULTY_PERCENT);
    }

    /**
     * Build a captcha whose visual obstacles scale with {@code difficultyPercent}
     * (0 = easiest, 100 = current/hardest behavior). The thresholds below map
     * the percentage to a small number of discrete steps so the appearance is
     * predictable:
     *
     *   >= 75%: complex background + 2 noise lines + gimpy distortion (current default)
     *   >= 50%: complex background + 1 noise line + gimpy distortion
     *   >= 25%: complex background + 1 noise line, no distortion
     *    <25%: flat background, no noise, no distortion (just text + border)
     *
     * Text and border are always present so the challenge is never trivially
     * blank.
     */
    public Captcha createCaptcha(int width, int height, int sizeOfCaptcha, int difficultyPercent) {
        int d = Math.max(0, Math.min(100, difficultyPercent));

        BackgroundProducer background = (d >= 25)
                ? getRandomBackgroundProducer(BACKGROUNDS)
                : new FlatColorBackgroundProducer();

        int noiseLines;
        if (d >= 75) {
            noiseLines = 2;
        } else if (d >= 25) {
            noiseLines = 1;
        } else {
            noiseLines = 0;
        }

        boolean applyGimpy = d >= 50;

        Captcha.Builder builder = new Captcha.Builder(width, height)
                .addBackground(background)
                .addText(
                        new DefaultTextProducer(sizeOfCaptcha, SRC_CHARS),
                        new DefaultWordRenderer(COLORS, FONTS));
        for (int i = 0; i < noiseLines; i++) {
            builder = builder.addNoise(getRandomNoiseProducer(NOISES));
        }
        if (applyGimpy) {
            builder = builder.gimp(getRandomGimpyRenderer(GIMPYS));
        }
        return builder.addBorder().build();
    }

    // Retrieve the captcha image
    public BufferedImage getCaptchaImage(Captcha captcha) {
        return captcha.getImage();
    }

    // Get a random background producer
    private BackgroundProducer getRandomBackgroundProducer(List<BackgroundProducer> bgProds) {
        return bgProds.get(RANDOM.nextInt(bgProds.size()));
    }

    // Get a random noise producer
    private NoiseProducer getRandomNoiseProducer(List<NoiseProducer> noiseProds) {
        return noiseProds.get(RANDOM.nextInt(noiseProds.size()));
    }

    // Get a random gimpy renderer
    private GimpyRenderer getRandomGimpyRenderer(List<GimpyRenderer> gimpyRends) {
        return gimpyRends.get(RANDOM.nextInt(gimpyRends.size()));
    }

    // Get a list of background producers
    private List<BackgroundProducer> bgProds() {
        return Arrays.asList(
                new TransparentBackgroundProducer(),
                new GradiatedBackgroundProducer(),
                new FlatColorBackgroundProducer(),
                new SquigglesBackgroundProducer());
    }

    // Get a list of noise producers
    private List<NoiseProducer> noiseProds() {
        return Arrays.asList(
                new CurvedLineNoiseProducer(),
                new StraightLineNoiseProducer());
    }

    // Get a list of gimpy renderers
    private List<GimpyRenderer> gimpyRends() {
        return Arrays.asList(
                new BlockGimpyRenderer(),
                new DropShadowGimpyRenderer(),
                // new FishEyeGimpyRenderer(),
                // new ShearGimpyRenderer(),
                // new StretchGimpyRenderer(),
                new RippleGimpyRenderer());
    }

    // Generate a character array
    private static char[] generateCharArray() {
        int size = 26 + 26 + 10; // Uppercase + Lowercase + Digits
        char[] combined = new char[size];
        int index = 0;

        // Add uppercase letters
        for (char c = 'A'; c <= 'Z'; c++) {
            combined[index++] = c;
        }

        // Add lowercase letters
        for (char c = 'a'; c <= 'z'; c++) {
            combined[index++] = c;
        }

        // Add digits
        for (char c = '0'; c <= '9'; c++) {
            combined[index++] = c;
        }

        return combined;
    }

    // Get a list of colors
    private List<Color> colors() {
        return Arrays.asList(
                Color.BLACK,
                Color.WHITE,
                Color.RED,
                Color.GREEN,
                Color.BLUE,
                Color.CYAN,
                Color.MAGENTA,
                Color.YELLOW,
                Color.PINK,
                Color.ORANGE,
                Color.LIGHT_GRAY,
                // Color.GRAY,
                Color.DARK_GRAY);
    }

    // Get a list of fonts
    private List<Font> fonts() {
        // Get the list of all font families available on the system
        GraphicsEnvironment ge = GraphicsEnvironment.getLocalGraphicsEnvironment();
        String[] fontFamilies = ge.getAvailableFontFamilyNames();

        // Add each font family with different styles (PLAIN, BOLD, ITALIC, BOLD +
        // ITALIC)
        List<Font> fonts = new ArrayList<>();
        for (String fontFamily : fontFamilies) {
            fonts.add(new Font(fontFamily, Font.PLAIN, 40));
            fonts.add(new Font(fontFamily, Font.BOLD, 40));
            fonts.add(new Font(fontFamily, Font.ITALIC, 40));
            fonts.add(new Font(fontFamily, Font.BOLD + Font.ITALIC, 40));
        }

        return fonts;
    }
}
