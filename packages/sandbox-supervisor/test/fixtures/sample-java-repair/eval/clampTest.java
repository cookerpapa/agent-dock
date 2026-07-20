public final class clampTest {
    public static void main(String[] args) {
        if (Calculator.clamp(12, 0, 10) != 10) throw new AssertionError("clamp high");
        if (Calculator.clamp(-2, 0, 10) != 0) throw new AssertionError("clamp low");
        System.out.println("clamp passed");
    }
}
